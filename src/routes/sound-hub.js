/**
 * sound-hub.js  --  "Original sound" + song library + who-used-it ranking.
 * Mounted at /api/v1/soundhub  (new paths only, nothing existing is touched).
 *
 *  GET  /for-post/:postId      sound shown under a Reel (title, artist, cover, owner photo, ...)
 *  GET  /:soundId              sound + the list of videos that used it (1st, 2nd, 3rd ...)
 *  POST /attach                after a post is created: register which sound it uses
 *  GET  /audio/:soundId        redirect to a playable audio/video file for "Use this sound"
 *  POST /upload-url            artist upload step 1: signed links straight to the music bucket
 *  POST /complete              artist upload step 2: save the song so search can find it
 *
 * Sound ids:  "orig_<postId>" = the original audio of a video   |  anything else = a library song (table "sounds")
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const { query, run } = require('../db');

const router = express.Router();

(async () => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS sound_uses (
      id TEXT PRIMARY KEY, sound_id TEXT NOT NULL, post_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await run('CREATE INDEX IF NOT EXISTS idx_sound_uses_sound ON sound_uses(sound_id)');
  } catch (e) { console.error('[SOUND-HUB] setup:', e.message); }
})();

function userFromReq(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return String(jwt.verify(h.slice(7), env.jwt.secret).sub); } catch (_) { return null; }
}
function auth(req, res, next) {
  const id = userFromReq(req);
  if (!id) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
  req.userId = id; next();
}

async function signedFromKey(key) {
  if (!key) return null;
  if (String(key).startsWith('http')) return String(key);
  try { return await require('../providers/b2').signedDownload(String(key), 3600); } catch (_) { return null; }
}
async function photoUrl(mediaId) {
  if (!mediaId) return null;
  try {
    const r = await query('SELECT storage_key FROM media WHERE id=$1 LIMIT 1', [mediaId]);
    return r.rows.length ? signedFromKey(r.rows[0].storage_key) : null;
  } catch (_) { return null; }
}
const displayName = u => [u.first_name || u.name, u.surname].filter(Boolean).join(' ') || u.username || 'Someone';

/** The music bucket is PRIVATE: turn a stored music link into a temporary signed link (24 h). Other links pass through. */
async function signMusicUrl(u) {
  if (!u) return null;
  const m = musicS3();
  if (!m) return String(u);
  const prefix = `https://${m.bucket}.${m.host}/`;
  if (!String(u).startsWith(prefix)) return String(u);
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const key = decodeURIComponent(String(u).slice(prefix.length).split('?')[0]);
    return await getSignedUrl(m.client, new GetObjectCommand({ Bucket: m.bucket, Key: key }), { expiresIn: 86400 });
  } catch (_) { return String(u); }
}

/** Everything the app needs to show one sound. null when it does not exist. */
async function resolveSound(soundId) {
  if (!soundId) return null;
  if (soundId.startsWith('orig_')) {
    const postId = soundId.slice(5);
    const r = await query(
      `SELECT p.id, p.author_id, u.first_name, u.name, u.surname, u.username, u.profile_photo_media_id
         FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id=$1 LIMIT 1`, [postId]);
    if (!r.rows.length) return null;
    const o = r.rows[0];
    return { id: soundId, title: 'Original sound', artist: displayName(o), cover_url: await photoUrl(o.profile_photo_media_id),
             is_original: true, owner_id: String(o.author_id), source_post_id: postId };
  }
  const r = await query(
    `SELECT s.*, u.first_name, u.name AS uname, u.surname, u.username, u.profile_photo_media_id
       FROM sounds s LEFT JOIN users u ON u.id = s.user_id WHERE s.id=$1 LIMIT 1`, [soundId]);
  if (!r.rows.length) return null;
  const s = r.rows[0];
  const cover = (await signMusicUrl(s.cover_art_url)) || await photoUrl(s.profile_photo_media_id);
  return { id: String(s.id), title: s.title || 'Untitled', artist: s.artist_name || displayName({ first_name: s.first_name, name: s.uname, surname: s.surname, username: s.username }),
           cover_url: cover || null, is_original: false, owner_id: s.user_id ? String(s.user_id) : null, audio_url: await signMusicUrl(s.audio_url) };
}

async function countUses(soundId) {
  const r = await query('SELECT COUNT(*) AS n FROM sound_uses WHERE sound_id=$1', [soundId]);
  return Number(r.rows[0].n || 0);
}

/* ---------------- sound under a Reel ---------------- */
router.get('/for-post/:postId', async (req, res) => {
  try {
    const l = await query('SELECT sound_id FROM sound_uses WHERE post_id=$1 LIMIT 1', [req.params.postId]);
    if (!l.rows.length) return res.json({ success: true, sound: null });
    const sound = await resolveSound(String(l.rows[0].sound_id));
    if (!sound) return res.json({ success: true, sound: null });
    sound.use_count = await countUses(sound.id);
    return res.json({ success: true, sound });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

/* ---------------- sound page: who used it, in order ---------------- */
router.get('/audio/:soundId', async (req, res) => {
  try {
    const id = String(req.params.soundId);
    let url = null;
    if (id.startsWith('orig_')) {
      const m = await query('SELECT storage_key FROM media WHERE post_id=$1 AND deleted_at IS NULL ORDER BY rowid ASC LIMIT 1', [id.slice(5)]);
      if (m.rows.length) url = await signedFromKey(m.rows[0].storage_key);
    } else {
      const s = await resolveSound(id);
      url = s && s.audio_url;
    }
    if (!url) return res.status(404).json({ success: false, error: 'NO_AUDIO' });
    return res.redirect(302, url);
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

router.get('/cover/:soundId', async (req, res) => {
  try {
    const sound = await resolveSound(String(req.params.soundId));
    if (!sound || !sound.cover_url) return res.status(404).json({ success: false, error: 'NO_COVER' });
    return res.redirect(302, sound.cover_url);
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

router.get('/:soundId', async (req, res) => {
  try {
    const sound = await resolveSound(String(req.params.soundId));
    if (!sound) return res.status(404).json({ success: false, error: 'SOUND_NOT_FOUND' });
    const u = await query(
      `SELECT su.post_id, su.user_id, su.created_at, us.first_name, us.name AS uname, us.surname, us.username
         FROM sound_uses su LEFT JOIN users us ON us.id = su.user_id
        WHERE su.sound_id=$1 ORDER BY su.rowid ASC LIMIT 200`, [sound.id]);
    const uses = [];
    let position = 0;
    for (const row of u.rows) {
      position++;
      let mediaUrl = null, mediaType = null;
      try {
        const m = await query('SELECT storage_key, type FROM media WHERE post_id=$1 AND deleted_at IS NULL ORDER BY rowid ASC LIMIT 1', [row.post_id]);
        if (m.rows.length) { mediaUrl = await signedFromKey(m.rows[0].storage_key); mediaType = m.rows[0].type; }
      } catch (_) { }
      uses.push({
        position, is_original: position === 1, post_id: row.post_id, user_id: String(row.user_id),
        author_name: displayName({ first_name: row.first_name, name: row.uname, surname: row.surname, username: row.username }),
        media_url: mediaUrl, media_type: mediaType, created_at: row.created_at
      });
    }
    sound.use_count = uses.length;
    return res.json({ success: true, sound, uses });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

/* ---------------- register the sound of a new post ---------------- */
router.post('/attach', auth, async (req, res) => {
  try {
    const postId = String((req.body && req.body.postId) || '').trim();
    const isVideo = !!(req.body && req.body.isVideo);
    let soundId = req.body && req.body.soundId ? String(req.body.soundId) : null;
    if (!postId) return res.status(400).json({ success: false, error: 'POST_REQUIRED' });

    const p = await query('SELECT author_id FROM posts WHERE id=$1 LIMIT 1', [postId]);
    if (!p.rows.length) return res.status(404).json({ success: false, error: 'POST_NOT_FOUND' });
    if (String(p.rows[0].author_id) !== req.userId) return res.status(403).json({ success: false, error: 'NOT_YOUR_POST' });

    if (!soundId) {
      if (!isVideo) return res.json({ success: true, sound: null });   // photos / text have no sound
      soundId = 'orig_' + postId;                                       // the video's own audio = its original sound
    } else if (!(await resolveSound(soundId))) {
      return res.status(404).json({ success: false, error: 'SOUND_NOT_FOUND' });
    }

    const exists = await query('SELECT 1 FROM sound_uses WHERE post_id=$1 LIMIT 1', [postId]);
    if (!exists.rows.length) {
      await run('INSERT INTO sound_uses (id, sound_id, post_id, user_id) VALUES ($1,$2,$3,$4)', [uuidv4(), soundId, postId, req.userId]);
      if (!soundId.startsWith('orig_')) {
        try { await run('UPDATE sounds SET used_in_videos = COALESCE(used_in_videos,0) + 1 WHERE id=$1', [soundId]); } catch (_) { }
      }
    }
    const sound = await resolveSound(soundId);
    if (sound) sound.use_count = await countUses(soundId);
    return res.json({ success: true, sound });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

/* ---------------- artist upload straight to the music bucket ---------------- */
let s3cache = null;
function musicS3() {
  if (s3cache) return s3cache;
  const { MUSIC_B2_KEY_ID: id, MUSIC_B2_APP_KEY: key, MUSIC_B2_ENDPOINT: ep, MUSIC_B2_BUCKET: bucket } = process.env;
  if (!id || !key || !ep || !bucket) return null;
  const { S3Client } = require('@aws-sdk/client-s3');
  const endpoint = /^https?:\/\//.test(ep) ? ep : 'https://' + ep;
  s3cache = {
    bucket,
    host: endpoint.replace(/^https?:\/\//, ''),
    client: new S3Client({ region: process.env.MUSIC_B2_REGION || 'us-east-005', endpoint,
                           credentials: { accessKeyId: id, secretAccessKey: key } })
  };
  return s3cache;
}
const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
                    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

router.post('/upload-url', auth, async (req, res) => {
  try {
    const m = musicS3();
    if (!m) return res.status(503).json({ success: false, error: 'MUSIC_STORAGE_NOT_CONFIGURED' });
    const title = String((req.body && req.body.title) || '').trim();
    const artistName = String((req.body && req.body.artistName) || '').trim();
    const audioType = String((req.body && req.body.audioType) || '').toLowerCase();
    const audioSize = Number(req.body && req.body.audioSize) || 0;
    const coverType = String((req.body && req.body.coverType) || '').toLowerCase();
    if (!title || !artistName) return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
    if (!AUDIO_EXT[audioType]) return res.status(400).json({ success: false, error: 'UNSUPPORTED_AUDIO_TYPE' });
    if (audioSize <= 0 || audioSize > 30 * 1024 * 1024) return res.status(400).json({ success: false, error: 'AUDIO_TOO_LARGE' });
    if (coverType && !IMAGE_EXT[coverType]) return res.status(400).json({ success: false, error: 'UNSUPPORTED_COVER_TYPE' });

    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const soundId = uuidv4();
    const audioKey = `songs/${soundId}.${AUDIO_EXT[audioType]}`;
    const out = { success: true, soundId, audioUrl: `https://${m.bucket}.${m.host}/${audioKey}` };
    out.audioUploadUrl = await getSignedUrl(m.client, new PutObjectCommand({ Bucket: m.bucket, Key: audioKey, ContentType: audioType }), { expiresIn: 900 });
    if (coverType) {
      const coverKey = `covers/${soundId}.${IMAGE_EXT[coverType]}`;
      out.coverUrl = `https://${m.bucket}.${m.host}/${coverKey}`;
      out.coverUploadUrl = await getSignedUrl(m.client, new PutObjectCommand({ Bucket: m.bucket, Key: coverKey, ContentType: coverType }), { expiresIn: 900 });
    }
    return res.json(out);
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

router.post('/complete', auth, async (req, res) => {
  try {
    const m = musicS3();
    if (!m) return res.status(503).json({ success: false, error: 'MUSIC_STORAGE_NOT_CONFIGURED' });
    const b = req.body || {};
    const prefix = `https://${m.bucket}.${m.host}/`;
    const soundId = String(b.soundId || '');
    const title = String(b.title || '').trim();
    const artistName = String(b.artistName || '').trim();
    const audioUrl = String(b.audioUrl || '');
    const coverUrl = b.coverUrl ? String(b.coverUrl) : null;
    if (!soundId || !title || !artistName) return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
    // only links that point into OUR music bucket are accepted
    if (!audioUrl.startsWith(prefix + 'songs/') || (coverUrl && !coverUrl.startsWith(prefix + 'covers/'))) {
      return res.status(400).json({ success: false, error: 'INVALID_URL' });
    }
    // make sure the file really arrived (works with a private bucket)
    try {
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      await m.client.send(new HeadObjectCommand({ Bucket: m.bucket, Key: audioUrl.slice(prefix.length) }));
    } catch (_) { return res.status(400).json({ success: false, error: 'UPLOAD_NOT_FOUND' }); }

    await run('INSERT INTO sounds (id, user_id, title, artist_name, audio_url, cover_art_url) VALUES ($1,$2,$3,$4,$5,$6)',
      [soundId, req.userId, title, artistName, audioUrl, coverUrl]);
    try { await run('UPDATE users SET is_artist=1 WHERE id=$1', [req.userId]); } catch (_) { }
    return res.json({ success: true, sound: await resolveSound(soundId) });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
