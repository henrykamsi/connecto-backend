/**
 * content-safety.js
 *
 *  1) POST /api/v1/moderation/scan   -> checks a post's text AND its image / video frames
 *       body: { text?: string, images?: [base64 jpeg, ...] }   (max 6 images)
 *       reply: { success, action: "ALLOW" | "BLOCK", checked, reasons: [...] }
 *
 *  2) highlightMiddleware  (runs in front of POST /api/v1/posts)
 *       When the post text contains the token  [@]  the token is removed from the text and,
 *       once the post is created, the author's followers get
 *       "<Name> highlighted a post for you to take a look at".
 *       Limit: 2 highlights per author per day (Nigeria time). Above the limit nothing is
 *       sent and nothing is shown to the user; the post itself is published normally.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const { query, run } = require('../db');

const router = express.Router();

const num = (name, d) => { const v = parseFloat(process.env[name]); return Number.isFinite(v) ? v : d; };
const T = {
  sexual:   num('MOD_SEXUAL', 0.5),      // nudity / sexual content
  minors:   num('MOD_MINORS', 0.05),     // anything sexual involving minors: very strict
  graphic:  num('MOD_GRAPHIC', 0.6),     // graphic violence
  selfHarm: num('MOD_SELFHARM', 0.6),
  hate:     num('MOD_HATE', 0.6),
  threat:   num('MOD_THREAT', 0.4),
  harass:   num('MOD_HARASS', 0.7)
};
const DAILY_HIGHLIGHT_LIMIT = 2;

(async () => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS moderation_events (
      id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, reasons TEXT, max_score REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await run(`CREATE TABLE IF NOT EXISTS post_highlights (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, post_id TEXT, day TEXT NOT NULL,
      followers_notified INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await run('CREATE INDEX IF NOT EXISTS idx_post_highlights_user_day ON post_highlights(user_id, day)');
  } catch (e) { console.error('[CONTENT-SAFETY] table setup:', e.message); }
})();

function userFromReq(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return String(jwt.verify(h.slice(7), env.jwt.secret).sub); } catch (_) { return null; }
}

function authUser(req, res, next) {
  const id = userFromReq(req);
  if (!id) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
  req.userId = id;
  next();
}

/* ------------------------- banned words (from your control panel) ------------------------- */
let bannedCache = { at: 0, words: [] };
async function bannedWords() {
  if (Date.now() - bannedCache.at < 60000) return bannedCache.words;
  try {
    const r = await query('SELECT word FROM banned_words');
    bannedCache = { at: Date.now(), words: r.rows.map(x => String(x.word || '')).filter(Boolean) };
  } catch (_) { bannedCache = { at: Date.now(), words: bannedCache.words }; }
  return bannedCache.words;
}

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '@': 'a', '$': 's', '!': 'i' };
function squash(s) { return ' ' + String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' '; }

function hasBannedWord(text, words) {
  if (!text || !words.length) return false;
  const plain = squash(text);
  const leet = squash(String(text).toLowerCase().replace(/[01345@$!]/g, c => LEET[c]));
  for (const w of words) {
    const nw = squash(w);
    if (nw.trim() && (plain.includes(nw) || leet.includes(nw))) return true;
  }
  return false;
}

/* ------------------------------------ OpenAI moderation ----------------------------------- */
function openAiKeys() {
  return (process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY || '')
    .split(',').map(k => k.trim()).filter(Boolean);
}

/** returns category_scores, or null when the check could not be done */
async function openAiScores(item) {
  const keys = openAiKeys();
  if (!keys.length) return null;
  const body = JSON.stringify({ model: 'omni-moderation-latest', input: [item] });
  for (const key of keys) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const resp = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body,
        signal: ctl.signal
      });
      if (resp.ok) {
        const data = await resp.json();
        return (data.results && data.results[0] && data.results[0].category_scores) || {};
      }
    } catch (_) { /* try the next key */ } finally { clearTimeout(timer); }
  }
  return null;
}

function reasonsFromScores(s) {
  const out = [];
  if ((s.sexual || 0) >= T.sexual || (s['sexual/minors'] || 0) >= T.minors) out.push('nudity or sexual content');
  if ((s['violence/graphic'] || 0) >= T.graphic) out.push('graphic violence');
  if ((s['self-harm/intent'] || 0) >= T.selfHarm || (s['self-harm/instructions'] || 0) >= T.selfHarm) out.push('self-harm');
  if ((s.hate || 0) >= T.hate || (s['hate/threatening'] || 0) >= T.threat) out.push('hate');
  if ((s['harassment/threatening'] || 0) >= T.threat || (s.harassment || 0) >= T.harass) out.push('harassment');
  return out;
}

/* ------------------------------------------ SCAN ------------------------------------------ */
router.post('/scan', authUser, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    const images = Array.isArray(req.body && req.body.images) ? req.body.images.filter(x => typeof x === 'string' && x.length > 100) : [];
    if (!text && !images.length) return res.status(400).json({ success: false, error: 'NOTHING_TO_SCAN' });
    if (images.length > 6) return res.status(400).json({ success: false, error: 'TOO_MANY_IMAGES' });
    if (images.some(x => x.length > 2500000)) return res.status(413).json({ success: false, error: 'IMAGE_TOO_LARGE' });

    const reasons = new Set();
    let degraded = false;
    let maxScore = 0;

    if (text) {
      if (hasBannedWord(text, await bannedWords())) reasons.add('profanity');
    }

    const jobs = [];
    if (text) jobs.push(openAiScores({ type: 'text', text }));
    for (const b64 of images) {
      jobs.push(openAiScores({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }));
    }
    const results = await Promise.all(jobs);
    for (const s of results) {
      if (!s) { degraded = true; continue; }
      for (const v of Object.values(s)) if (typeof v === 'number' && v > maxScore) maxScore = v;
      reasonsFromScores(s).forEach(r => reasons.add(r));
    }

    const list = Array.from(reasons);
    if (list.length) {
      try {
        await run('INSERT INTO moderation_events (id, user_id, kind, reasons, max_score) VALUES ($1,$2,$3,$4,$5)',
          [uuidv4(), req.userId, images.length ? 'media' : 'text', list.join(', '), maxScore]);
      } catch (_) { }
    }
    return res.json({
      success: true,
      action: list.length ? 'BLOCK' : 'ALLOW',
      checked: !degraded,
      reasons: list,
      label: list.length ? 'UPLOAD_BLOCKED' : null,
      score: maxScore
    });
  } catch (err) {
    console.error('[CONTENT-SAFETY scan]', err.message);
    // Never stop people from posting because of a server problem: report "not checked".
    return res.json({ success: true, action: 'ALLOW', checked: false, reasons: [] });
  }
});

/* --------------------------------------- HIGHLIGHT ---------------------------------------- */
function lagosDay() { return new Date(Date.now() + 3600000).toISOString().slice(0, 10); } // UTC+1

async function fanOutHighlight(userId, postId) {
  const day = lagosDay();
  const rowId = uuidv4();
  await run('INSERT INTO post_highlights (id, user_id, post_id, day) VALUES ($1,$2,$3,$4)', [rowId, userId, postId, day]);

  // Race-safe: only the first DAILY_HIGHLIGHT_LIMIT rows of the day may send.
  const first = await query(
    `SELECT id FROM post_highlights WHERE user_id=$1 AND day=$2 ORDER BY rowid ASC LIMIT ${DAILY_HIGHLIGHT_LIMIT}`,
    [userId, day]
  );
  if (!first.rows.some(r => r.id === rowId)) return { sent: 0, reason: 'daily limit' };

  const u = await query('SELECT * FROM users WHERE id=$1 LIMIT 1', [userId]);
  const row = u.rows[0] || {};
  const name = row.first_name || row.name || row.username || 'Someone';

  const f = await query('SELECT follower_id FROM follows WHERE following_id=$1 LIMIT 5000', [userId]);
  const ids = f.rows.map(r => String(r.follower_id)).filter(id => id !== String(userId));

  const { notify } = require('../services/notifications');
  let sent = 0;
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(async fid => {
      try {
        await notify({
          userId: fid,
          actorId: userId,
          type: 'HIGHLIGHT',
          title: 'Highlighted post',
          body: name + ' highlighted a post for you to take a look at',
          targetType: 'post',
          targetId: postId
        });
        sent++;
      } catch (e) { console.error('[HIGHLIGHT notify]', e.message); }
    }));
  }
  try { await run('UPDATE post_highlights SET followers_notified=$1 WHERE id=$2', [sent, rowId]); } catch (_) { }
  return { sent };
}

function highlightMiddleware(req, res, next) {
  try {
    const raw = req.body && typeof req.body.body === 'string' ? req.body.body : '';
    if (!/\[@\]/.test(raw)) return next();

    // the token is never stored or shown
    req.body.body = raw.replace(/\[@\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();

    const userId = userFromReq(req);
    const scheduled = !!req.body.scheduledTime;
    const isPrivate = req.body.visibility === 'private' || req.body.privacy === 'private';
    if (!userId || scheduled || isPrivate) return next();

    const original = res.json.bind(res);
    res.json = function (payload) {
      const out = original(payload);
      try {
        const ok = payload && payload.success !== false && res.statusCode < 400;
        const postId = payload && ((payload.post && payload.post.id) || payload.id || payload.postId || payload.post_id);
        if (ok && postId) {
          setImmediate(() => fanOutHighlight(userId, String(postId)).catch(e => console.error('[HIGHLIGHT]', e.message)));
        }
      } catch (_) { }
      return out;
    };
    return next();
  } catch (_) {
    return next();
  }
}

module.exports = { router, highlightMiddleware, fanOutHighlight, hasBannedWord };
