/**
 * chat-live.js  --  clean, single-definition chat endpoints (no duplicates).
 *
 *   POST /api/v1/chat/live/send        send a message (saves, delivers live, pushes FCM)
 *   POST /api/v1/chat/live/edit        edit your own message
 *   POST /api/v1/chat/live/seen        mark a conversation's incoming messages as seen
 *   POST /api/v1/chat/live/delivered   mark incoming messages as delivered
 *   GET  /api/v1/chat/live/presence/:userId   { online, last_seen }
 *
 * Uses ONLY message columns that the working send handler already uses
 * (id, conversation_id, sender_id, body, message_type, media_url, sent_at)
 * plus delivered_at / received_at / read_at / seen_at / edited_at, which the
 * existing messages-v2 / seen / delivered routes already read and write.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const { query, run } = require('../db');
const realtime = require('../websocket/realtime');

const router = express.Router();

// Make sure the optional columns exist (harmless if they already do).
(async () => {
  for (const col of ['seen_at', 'received_at', 'delivered_at', 'read_at', 'edited_at']) {
    try { await run(`ALTER TABLE messages ADD COLUMN ${col} TEXT`); } catch (_) { }
  }
  try { await run('ALTER TABLE users ADD COLUMN last_seen TEXT'); } catch (_) { }
})();

function authUser(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
  }
  try {
    req.userId = String(jwt.verify(h.slice(7), env.jwt.secret).sub);
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'INVALID_SESSION' });
  }
}

function toIso(v) {
  if (!v) return null;
  const s = String(v);
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return s;
  return s.replace(' ', 'T') + 'Z'; // Turso CURRENT_TIMESTAMP is UTC without a zone marker
}

async function isMember(convId, userId) {
  const r = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 LIMIT 1',
    [convId, userId]
  );
  return r.rows.length > 0;
}

async function otherMembers(convId, userId) {
  const r = await query(
    'SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id != $2',
    [convId, userId]
  );
  return r.rows.map(x => String(x.user_id));
}

async function loadMessage(id) {
  const r = await query(
    `SELECT m.id, m.conversation_id, m.body, m.message_type, m.sender_id, m.sent_at,
            m.delivered_at, m.read_at, m.seen_at, m.edited_at, m.deleted_at, m.media_url,
            u.username, u.first_name, u.surname
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.id=$1 LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

function publicMessage(m) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    body: m.body,
    message_type: m.message_type,
    sender_id: m.sender_id,
    sent_at: toIso(m.sent_at),
    delivered_at: toIso(m.delivered_at),
    read_at: toIso(m.read_at),
    seen_at: toIso(m.seen_at),
    edited_at: toIso(m.edited_at),
    deleted_at: toIso(m.deleted_at),
    media_url: m.media_url,
    username: m.username,
    first_name: m.first_name,
    surname: m.surname
  };
}

function pushFcm(recipientId, title, body, convId, senderId) {
  try {
    const { sendToUser } = require('../services/fcm');
    sendToUser(recipientId, { title, body }, {
      type: 'MESSAGE',
      target_type: 'conversation',
      target_id: convId,
      conversationId: convId,
      senderId: senderId
    }).catch(() => { });
  } catch (_) { }
}

/* ------------------------------ SEND ------------------------------ */
router.post('/send', authUser, async (req, res) => {
  try {
    const me = req.userId;
    const convId = String(req.body.conversationId || '').trim();
    const body = String(req.body.body || '').trim();
    const mediaUrl = req.body.mediaUrl || null;
    const messageType = mediaUrl ? 'image' : 'text';

    if (!convId) return res.status(400).json({ success: false, error: 'CONVERSATION_REQUIRED' });
    if (!body && !mediaUrl) return res.status(400).json({ success: false, error: 'EMPTY_MESSAGE' });
    if (body.length > 5000) return res.status(400).json({ success: false, error: 'MESSAGE_TOO_LONG' });
    if (!(await isMember(convId, me))) {
      return res.status(403).json({ success: false, error: 'NOT_A_MEMBER' });
    }

    const id = uuidv4();
    const nowIso = new Date().toISOString();

    await run(
      'INSERT INTO messages (id, conversation_id, sender_id, body, message_type, media_url, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, convId, me, body, messageType, mediaUrl, nowIso]
    );
    try { await run('UPDATE conversations SET updated_at=$1 WHERE id=$2', [nowIso, convId]); } catch (_) { }

    const recipients = await otherMembers(convId, me);
    let delivered = false;
    for (const r of recipients) {
      if (realtime.isOnline(r)) delivered = true;
    }
    if (delivered) {
      await run(
        'UPDATE messages SET delivered_at=COALESCE(delivered_at,CURRENT_TIMESTAMP), received_at=COALESCE(received_at,CURRENT_TIMESTAMP) WHERE id=$1',
        [id]
      );
    }

    const saved = await loadMessage(id);
    const message = publicMessage(saved);

    let senderName = [saved.first_name, saved.surname].filter(Boolean).join(' ') || saved.username || 'New message';
    const preview = mediaUrl && !body ? '📷 Photo' : body.slice(0, 140);

    for (const r of recipients) {
      const online = realtime.isOnline(r);
      if (online) {
        realtime.sendToUser(r, { type: 'MESSAGE', conversationId: convId, message });
      }
      // Notify unless they are looking at this very conversation right now.
      if (!(online && realtime.activeConversation(r) === convId)) {
        pushFcm(r, senderName, preview, convId, me);
      }
    }

    return res.status(201).json({ success: true, message });
  } catch (err) {
    console.error('[CHAT-LIVE send]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------ EDIT ------------------------------ */
router.post('/edit', authUser, async (req, res) => {
  try {
    const me = req.userId;
    const messageId = String(req.body.messageId || '').trim();
    const body = String(req.body.body || '').trim();
    if (!messageId || !body) return res.status(400).json({ success: false, error: 'MESSAGE_AND_BODY_REQUIRED' });

    const m = await loadMessage(messageId);
    if (!m) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (String(m.sender_id) !== me) return res.status(403).json({ success: false, error: 'NOT_YOUR_MESSAGE' });
    if (m.deleted_at) return res.status(400).json({ success: false, error: 'MESSAGE_DELETED' });

    await run('UPDATE messages SET body=$1, edited_at=CURRENT_TIMESTAMP WHERE id=$2 AND sender_id=$3', [body, messageId, me]);
    const message = publicMessage(await loadMessage(messageId));

    for (const r of await otherMembers(m.conversation_id, me)) {
      realtime.sendToUser(r, { type: 'EDITED', conversationId: m.conversation_id, message });
    }
    return res.json({ success: true, message });
  } catch (err) {
    console.error('[CHAT-LIVE edit]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------ SEEN ------------------------------ */
router.post('/seen', authUser, async (req, res) => {
  try {
    const me = req.userId;
    const convId = String(req.body.conversationId || '').trim();
    if (!convId) return res.status(400).json({ success: false, error: 'CONVERSATION_REQUIRED' });
    if (!(await isMember(convId, me))) return res.status(403).json({ success: false, error: 'NOT_A_MEMBER' });

    await run(
      `UPDATE messages
          SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
              received_at  = COALESCE(received_at,  CURRENT_TIMESTAMP),
              seen_at      = COALESCE(seen_at,      CURRENT_TIMESTAMP),
              read_at      = COALESCE(read_at,      CURRENT_TIMESTAMP)
        WHERE conversation_id=$1 AND sender_id != $2 AND (seen_at IS NULL OR read_at IS NULL)`,
      [convId, me]
    );

    for (const r of await otherMembers(convId, me)) {
      realtime.sendToUser(r, { type: 'SEEN', conversationId: convId, userId: me, at: new Date().toISOString() });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[CHAT-LIVE seen]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* --------------------------- DELIVERED ---------------------------- */
async function markDeliveredForUser(userId, onlyConvId) {
  userId = String(userId);
  const params = [userId];
  let convFilter = '';
  if (onlyConvId) { params.push(onlyConvId); convFilter = ' AND m.conversation_id = $2'; }

  const pending = await query(
    `SELECT DISTINCT m.conversation_id AS cid, m.sender_id AS sid
       FROM messages m
      WHERE m.delivered_at IS NULL AND m.sender_id != $1${convFilter}
        AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1)`,
    params
  );
  if (!pending.rows.length) return 0;

  await run(
    `UPDATE messages
        SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
            received_at  = COALESCE(received_at,  CURRENT_TIMESTAMP)
      WHERE delivered_at IS NULL AND sender_id != $1${convFilter.replace(/m\./g, '')}
        AND conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1)`,
    params
  );

  const at = new Date().toISOString();
  for (const row of pending.rows) {
    realtime.sendToUser(String(row.sid), { type: 'DELIVERED', conversationId: row.cid, userId, at });
  }
  return pending.rows.length;
}

router.post('/delivered', authUser, async (req, res) => {
  try {
    const convId = String(req.body.conversationId || '').trim() || null;
    if (convId && !(await isMember(convId, req.userId))) {
      return res.status(403).json({ success: false, error: 'NOT_A_MEMBER' });
    }
    const n = await markDeliveredForUser(req.userId, convId);
    return res.json({ success: true, updatedConversations: n });
  } catch (err) {
    console.error('[CHAT-LIVE delivered]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* --------------------------- PRESENCE ----------------------------- */
router.get('/presence/:userId', authUser, async (req, res) => {
  try {
    const id = String(req.params.userId);
    const online = realtime.isOnline(id);
    let lastSeen = null;
    try {
      const r = await query('SELECT last_seen FROM users WHERE id=$1 LIMIT 1', [id]);
      if (r.rows.length) lastSeen = toIso(r.rows[0].last_seen);
    } catch (_) { }
    return res.json({ success: true, online, last_seen: lastSeen });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ---- presence for many people at once (Friends list) ---- */
router.post('/presence-batch', authUser, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.userIds)
      ? Array.from(new Set(req.body.userIds.map(String))).slice(0, 100) : [];
    if (!ids.length) return res.json({ success: true, presence: {} });
    const marks = ids.map((_, i) => '$' + (i + 1)).join(',');
    let rows = [];
    try { rows = (await query(`SELECT id, last_seen FROM users WHERE id IN (${marks})`, ids)).rows; } catch (_) { }
    const seen = {};
    rows.forEach(r => { seen[String(r.id)] = toIso(r.last_seen); });
    const presence = {};
    for (const id of ids) presence[id] = { online: realtime.isOnline(id), last_seen: seen[id] || null };
    return res.json({ success: true, presence });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ---- who is on the other side of this conversation + their presence ---- */
router.get('/conversation/:convId/presence', authUser, async (req, res) => {
  try {
    const convId = String(req.params.convId);
    if (!(await isMember(convId, req.userId))) {
      return res.status(403).json({ success: false, error: 'NOT_A_MEMBER' });
    }
    const others = await otherMembers(convId, req.userId);
    if (!others.length) return res.json({ success: true, userId: null, online: false, last_seen: null });
    const id = others[0];
    let lastSeen = null;
    try {
      const r = await query('SELECT last_seen FROM users WHERE id=$1 LIMIT 1', [id]);
      if (r.rows.length) lastSeen = toIso(r.rows[0].last_seen);
    } catch (_) { }
    return res.json({ success: true, userId: id, online: realtime.isOnline(id), last_seen: lastSeen });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.markDeliveredForUser = markDeliveredForUser;
