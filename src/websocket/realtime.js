const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const env = require('../config/env');

// userId -> Set of open sockets. Module-level so other files can ask "is this user online?"
const clients = new Map();
const lastSeenWrite = new Map(); // userId -> ms of last DB write (throttle)
const activeConv = new Map();   // userId -> conversation id they are looking at right now

function isOnline(userId) {
  const set = clients.get(String(userId));
  if (!set) return false;
  for (const s of set) if (s.readyState === 1) return true;
  return false;
}

function activeConversation(userId) {
  return activeConv.get(String(userId)) || null;
}

function sendToUser(userId, payload) {
  const set = clients.get(String(userId));
  if (!set) return 0;
  const text = JSON.stringify(payload);
  let n = 0;
  for (const s of set) {
    if (s.readyState === 1) {
      try { s.send(text); n++; } catch (_) { }
    }
  }
  return n;
}

async function touchLastSeen(userId, force) {
  try {
    const now = Date.now();
    if (!force && now - (lastSeenWrite.get(userId) || 0) < 60000) return;
    lastSeenWrite.set(userId, now);
    const { run } = require('../db');
    await run('UPDATE users SET last_seen=CURRENT_TIMESTAMP WHERE id=$1', [userId]);
  } catch (_) { }
}

function attachRealtime(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws'
  });

  wss.on('connection', (socket) => {
    let userId = null;

    socket.send(JSON.stringify({
      type: 'CONNECTED',
      message: 'Connecto realtime connected'
    }));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'AUTH') {
          const payload = jwt.verify(msg.token, env.jwt.secret);
          userId = String(payload.sub);

          if (!clients.has(userId)) {
            clients.set(userId, new Set());
          }

          clients.get(userId).add(socket);

          socket.send(JSON.stringify({ type: 'AUTHENTICATED' }));

          // Presence + delivery: this user just came online.
          touchLastSeen(userId, true);
          try {
            require('../routes/chat-live').markDeliveredForUser(userId);
          } catch (_) { }
          return;
        }

        if (!userId) return;

        if (msg.type === 'VIEW') {
          if (msg.conversationId) activeConv.set(userId, String(msg.conversationId));
          else activeConv.delete(userId);
          return;
        }

        if (
          ['TYPING_START', 'TYPING_STOP', 'CALL_SIGNAL', 'MESSAGE'].includes(msg.type)
          && msg.targetUserId
        ) {
          const targets = clients.get(String(msg.targetUserId)) || new Set();

          for (const target of targets) {
            if (target.readyState === 1) {
              target.send(JSON.stringify({
                ...msg,
                senderUserId: userId
              }));
            }
          }
        }

        if (msg.type === 'PING') {
          socket.send(JSON.stringify({ type: 'PONG' }));
          touchLastSeen(userId, false);
        }

      } catch (err) {
        try {
          socket.send(JSON.stringify({
            type: 'ERROR',
            error: 'Invalid realtime message'
          }));
        } catch (_) { }
      }
    });

    socket.on('close', () => {
      if (!userId) return;

      const set = clients.get(userId);
      if (!set) return;

      set.delete(socket);

      if (!set.size) {
        clients.delete(userId);
        activeConv.delete(userId);
        touchLastSeen(userId, true); // record when they went offline
      }
    });
  });

  return wss;
}

module.exports = { attachRealtime, isOnline, sendToUser, activeConversation };
