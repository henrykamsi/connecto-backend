const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const env = require('../config/env');

function attachRealtime(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws'
  });

  const clients = new Map();

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
          userId = payload.sub;

          if (!clients.has(userId)) {
            clients.set(userId, new Set());
          }

          clients.get(userId).add(socket);

          socket.send(JSON.stringify({ type: 'AUTHENTICATED' }));
          return;
        }

        if (!userId) return;

        if (
          ['TYPING_START', 'TYPING_STOP', 'CALL_SIGNAL', 'MESSAGE'].includes(msg.type)
          && msg.targetUserId
        ) {
          const targets = clients.get(msg.targetUserId) || new Set();

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
      }
    });
  });

  return wss;
}

module.exports = { attachRealtime };
