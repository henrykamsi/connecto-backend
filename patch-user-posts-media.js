const fs = require('fs');
const path = 'src/routes/complete-v1.js';
let s = fs.readFileSync(path, 'utf8');

if (s.includes('[USER-POSTS-MEDIA]')) {
  console.log('already patched — skipping');
  process.exit(0);
}

const anchor = "router.get('/users/:id/posts',auth,async(req,res,next)=>{";
if (!s.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const startIdx = s.indexOf(anchor);
const afterStart = startIdx + anchor.length;
const nextRouteIdx = s.indexOf("router.", afterStart);
if (nextRouteIdx === -1) {
  console.error("ERROR: next route not found");
  process.exit(1);
}

const newHandler = `router.get('/users/:id/posts',auth,async(req,res,next)=>{
  /* [USER-POSTS-MEDIA] */
  try {
    const limit = Math.min(Number(req.query.limit || 20), 50);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const type = String(req.query.type || '').toLowerCase();

    let extra = '';
    if (type === 'image') {
      extra = " AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='image' AND m.deleted_at IS NULL)";
    } else if (type === 'video') {
      extra = " AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL)";
    }

    const r = await query(
      \`SELECT p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.like_count_visible, p.share_enabled, p.original_post_id, p.created_at, p.updated_at, p.deleted_at,
              u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified AS author_verified,
              COALESCE(p.view_count, 0) AS view_count,
              (u.pinned_post_id = p.id) AS pinned,
              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key,
              (SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.author_id=$1 AND p.deleted_at IS NULL
         AND p.audience='public'
         \${extra}
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3\`,
      [req.params.id, limit, offset]
    );

    const b2 = require('../providers/b2');
    const posts = await Promise.all(r.rows.map(async row => {
      let mediaUrl = null;
      if (row.media_key) {
        try {
          if (String(row.media_key).indexOf("http") === 0) {
            mediaUrl = row.media_key;
          } else {
            mediaUrl = await b2.signedDownload(row.media_key, 3600);
          }
        } catch (e) {
          console.error("[USER-POSTS-MEDIA]", e.message);
        }
      }
      return { ...row, media_url: mediaUrl, media_key: undefined };
    }));

    res.json({ success: true, posts, pagination: { limit, offset } });
  } catch(err) {
    next(err);
  }
});

`;

s = s.slice(0, startIdx) + newHandler + s.slice(nextRouteIdx);
fs.writeFileSync(path, s);
console.log('OK: /users/:id/posts now signs media and returns media_type');
