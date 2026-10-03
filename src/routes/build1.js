const express = require('express');
const { v4: uuidv4 } = require('uuid');
const auth = require('../middleware/auth');
const { query } = require('../db');
const b2 = require('../providers/b2');

const router = express.Router();

/* ============================================================
   BOOKMARKS
   ============================================================ */

router.post('/posts/:id/bookmark', auth, async (req, res, next) => {
  try {
    const existing = await query(
      'SELECT 1 FROM bookmarks WHERE user_id=$1 AND post_id=$2 LIMIT 1',
      [req.user.id, req.params.id]
    );
    if (existing.rows.length) {
      return res.json({ success: true, bookmarked: true });
    }
    await query(
      'INSERT INTO bookmarks (user_id, post_id) VALUES ($1, $2)',
      [req.user.id, req.params.id]
    );
    res.json({ success: true, bookmarked: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/posts/:id/bookmark', auth, async (req, res, next) => {
  try {
    await query(
      'DELETE FROM bookmarks WHERE user_id=$1 AND post_id=$2',
      [req.user.id, req.params.id]
    );
    res.json({ success: true, bookmarked: false });
  } catch (err) {
    next(err);
  }
});

router.get('/me/bookmarks', auth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 50);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const sql =
      'SELECT p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.like_count_visible, ' +
      'p.share_enabled, p.original_post_id, p.created_at, p.updated_at, p.deleted_at, ' +
      'u.first_name, u.surname, u.username, u.profile_photo_media_id, ' +
      'COALESCE(rc.reaction_count,0) reaction_count, ' +
      'COALESCE(cc.comment_count,0) comment_count, ' +
      '(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=$1 LIMIT 1) AS viewer_reacted_int, ' +
      '(SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key, ' +
      '(SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type ' +
      'FROM bookmarks b ' +
      'JOIN posts p ON p.id = b.post_id ' +
      'JOIN users u ON u.id = p.author_id ' +
      'LEFT JOIN ( SELECT post_id,COUNT(*) reaction_count FROM reactions GROUP BY post_id ) rc ON rc.post_id=p.id ' +
      'LEFT JOIN ( SELECT post_id,COUNT(*) comment_count FROM comments WHERE deleted_at IS NULL GROUP BY post_id ) cc ON cc.post_id=p.id ' +
      'WHERE b.user_id=$1 AND p.deleted_at IS NULL ' +
      'ORDER BY b.created_at DESC ' +
      'LIMIT $2 OFFSET $3';

    const r = await query(sql, [req.user.id, limit, offset]);

    const posts = await Promise.all(r.rows.map(async row => {
      let mediaUrl = null;
      if (row.media_key) {
        try {
          if (String(row.media_key).indexOf('http') === 0) {
            mediaUrl = row.media_key;
          } else {
            mediaUrl = await b2.signedDownload(row.media_key, 3600);
          }
        } catch (e) {
          console.error('[BOOKMARKS-MEDIA-SIGN]', e.message);
        }
      }
      return {
        ...row,
        viewer_has_reacted: Number(row.viewer_reacted_int) === 1,
        viewer_reacted_int: undefined,
        media_url: mediaUrl
      };
    }));

    res.json({ success: true, posts, pagination: { limit, offset } });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   HIDE POST
   ============================================================ */

router.post('/posts/:id/hide', auth, async (req, res, next) => {
  try {
    const existing = await query(
      'SELECT 1 FROM post_hides WHERE user_id=$1 AND post_id=$2 LIMIT 1',
      [req.user.id, req.params.id]
    );
    if (existing.rows.length) {
      return res.json({ success: true, hidden: true });
    }
    await query(
      'INSERT INTO post_hides (user_id, post_id) VALUES ($1, $2)',
      [req.user.id, req.params.id]
    );
    res.json({ success: true, hidden: true });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   DELETE POST — hard delete with B2 cleanup
   Aborts if B2 delete fails. Row is only removed once file is gone.
   ============================================================ */

router.delete('/posts/:id', auth, async (req, res, next) => {
  try {
    const post = await query(
      'SELECT * FROM posts WHERE id=$1 AND author_id=$2 LIMIT 1',
      [req.params.id, req.user.id]
    );
    if (!post.rows.length) {
      return res.status(404).json({ success: false, error: 'POST_NOT_FOUND_OR_NOT_OWNER' });
    }

    const media = await query(
      'SELECT id, storage_key FROM media WHERE post_id=$1',
      [req.params.id]
    );

    for (const m of media.rows) {
      if (m.storage_key && String(m.storage_key).indexOf('http') !== 0) {
        try {
          await b2.remove(m.storage_key);
        } catch (e) {
          console.error('[DELETE-POST-B2]', m.storage_key, e.message);
          return res.status(502).json({
            success: false,
            error: 'STORAGE_DELETE_FAILED',
            message: 'Could not delete the file from storage. Post was not deleted. Try again.',
            media_id: m.id
          });
        }
      }
    }

    await query('DELETE FROM posts WHERE id=$1', [req.params.id]);

    res.json({ success: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   EDIT POST
   ============================================================ */

router.patch('/posts/:id', auth, async (req, res, next) => {
  try {
    const post = await query(
      'SELECT * FROM posts WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL LIMIT 1',
      [req.params.id, req.user.id]
    );
    if (!post.rows.length) {
      return res.status(404).json({ success: false, error: 'POST_NOT_FOUND_OR_NOT_OWNER' });
    }

    if (req.body.text === undefined) {
      return res.status(400).json({ success: false, error: 'TEXT_REQUIRED' });
    }
    const newText = String(req.body.text);

    const result = await query(
      'UPDATE posts SET text=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING id, author_id, text, audience, created_at, updated_at',
      [newText, req.params.id]
    );

    res.json({ success: true, post: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   EXTENDED SETTINGS — bookmark privacy, monetization
   ============================================================ */

router.get('/settings/ext', auth, async (req, res, next) => {
  try {
    let r = await query('SELECT * FROM user_settings_ext WHERE user_id=$1 LIMIT 1', [req.user.id]);
    if (!r.rows.length) {
      await query('INSERT INTO user_settings_ext (user_id) VALUES ($1)', [req.user.id]);
      r = await query('SELECT * FROM user_settings_ext WHERE user_id=$1 LIMIT 1', [req.user.id]);
    }
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/settings/ext', auth, async (req, res, next) => {
  try {
    const allowed = ['bookmark_privacy', 'monetization_enabled', 'monetization_tier'];
    const fields = [];
    const values = [];
    let n = 1;

    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        fields.push(k + '=$' + n);
        values.push(req.body[k]);
        n++;
      }
    }
    if (!fields.length) {
      return res.status(400).json({ success: false, error: 'NO_FIELDS' });
    }

    await query('INSERT INTO user_settings_ext (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.id]);

    values.push(req.user.id);
    const sql = 'UPDATE user_settings_ext SET ' + fields.join(', ') + ', updated_at=CURRENT_TIMESTAMP WHERE user_id=$' + n;
    await query(sql, values);

    const r = await query('SELECT * FROM user_settings_ext WHERE user_id=$1 LIMIT 1', [req.user.id]);
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
