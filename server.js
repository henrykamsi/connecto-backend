const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");

const env = require("./src/config/env");
const { query } = require("./src/db");
const { attachRealtime } = require("./src/websocket/realtime");
const v1 = require("./src/routes/complete-v1");
const controlRouter = require("./control-server");

const app = express();
const server = http.createServer(app);

app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
  origin:
    env.corsOrigins === "*"
      ? "*"
      : env.corsOrigins.split(",").map(x => x.trim()),
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "10mb"
}));

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Connecto",
    version: "v1"
  });
});


/* GLOBAL WEBHOOK LOGGER v2 */
const WEBHOOK_EVENT_MAP = {
  "POST /api/v1/auth/register": "user.registered",
  "POST /api/v1/auth/login": "user.logged_in",
  "POST /api/v1/auth/logout": "user.logged_out",
  "POST /api/v1/auth/refresh": "token.refreshed",
  "POST /api/v1/profile/complete": "profile.completed",
  "PATCH /api/v1/profile": "profile.updated",
  "POST /api/v1/posts": "post.created",
  "POST /api/v1/posts/:postId/reactions": "post.reacted",
  "POST /api/v1/posts/:postId/comments": "comment.created",
  "POST /api/v1/social/follow/:userId": "user.followed",
  "DELETE /api/v1/social/follow/:userId": "user.unfollowed",
  "POST /api/v1/social/friend-request/:userId": "friend.requested",
  "POST /api/v1/social/friend-request/:id/accept": "friend.accepted",
  "POST /api/v1/chat/conversations": "chat.created",
  "POST /api/v1/chat/conversations/:id/messages": "message.sent",
  "POST /api/v1/calls": "call.initiated",
  "POST /api/v1/calls/:id/accept": "call.accepted",
  "POST /api/v1/calls/:id/reject": "call.rejected",
  "POST /api/v1/calls/:id/end": "call.ended",
  "POST /api/v1/blocks/:userId": "user.blocked",
  "POST /api/v1/reports": "report.created",
  "POST /api/v1/devices": "device.registered",
  "POST /api/v1/auth/change-password": "password.changed"
};

function matchWebhookEvent(method, path) {
  const keys = Object.keys(WEBHOOK_EVENT_MAP);
  for (let i = 0; i < keys.length; i++) {
    const parts = keys[i].split(" ");
    if (parts[0] !== method) continue;
    const regex = new RegExp("^" + parts[1].replace(/:[^/]+/g, "[^/]+") + "$");
    if (regex.test(path)) return WEBHOOK_EVENT_MAP[keys[i]];
  }
  return null;
}

app.use(function webhookLogger(req, res, next) {
  if (req.path.indexOf("/control-api") === 0) return next();
  if (req.path.indexOf("/ws") === 0) return next();

  const eventName = matchWebhookEvent(req.method, req.path);
  if (!eventName) return next();

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  let logged = false;

  async function logEvent(statusCode) {
    if (logged) return;
    logged = true;
    if (statusCode >= 400) return;

    try {
      const db = require("./src/db");
      const uuid = require("uuid");

      const actorId = req.user && req.user.id ? req.user.id : null;
      const targetId =
        (req.params && req.params.postId) ||
        (req.params && req.params.userId) ||
        (req.params && req.params.id) ||
        null;

      const payload = {
        method: req.method,
        path: req.path,
        actorId: actorId,
        targetId: targetId,
        status: statusCode,
        at: new Date().toISOString()
      };

      await db.run(
        "INSERT INTO webhook_events (id, direction, source, event_type, url, status, attempts, request_body, status_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          uuid.v4(),
          "internal",
          "connecto-api",
          eventName,
          null,
          "logged",
          0,
          JSON.stringify(payload),
          statusCode
        ]
      );

      console.log("[WEBHOOK LOGGED]", eventName);
    } catch (err) {
      console.error("[WEBHOOK LOG FAILED]", err.message);
    }
  }

  res.json = function(body) {
    const status = res.statusCode;
    logEvent(status).finally(function() {
      originalJson(body);
    });
    return res;
  };

  res.send = function(body) {
    const status = res.statusCode;
    logEvent(status).finally(function() {
      originalSend(body);
    });
    return res;
  };

  next();
});
app.use("/api/v1", v1);
app.use("/control-api", controlRouter);

app.use((err, req, res, next) => {
  console.error("[CONNECTO ERROR]", err);

  if (err.name === "ZodError") {
    return res.status(400).json({
      success: false,
      error: "Invalid request",
      details: err.issues
    });
  }

  if (err.code === "23505" || err.code === "SQLITE_CONSTRAINT") {
    return res.status(409).json({
      success: false,
      error: "A record with those values already exists"
    });
  }

  res.status(500).json({
    success: false,
    error: "Internal server error"
  });
});

async function start() {
  try {
    await query("SELECT 1 AS ok");

    console.log("[CONNECTO] Turso connected.");

    attachRealtime(server);

    server.listen(env.port, "0.0.0.0", () => {
      console.log("========================================");
      console.log("       CONNECTO COMPLETE V1 ONLINE");
      console.log("========================================");
      console.log(`HTTP: http://127.0.0.1:${env.port}`);
      console.log(`Health: http://127.0.0.1:${env.port}/api/v1/health`);
      console.log(`DB Health: http://127.0.0.1:${env.port}/api/v1/health/db`);
      console.log(`Providers: http://127.0.0.1:${env.port}/api/v1/providers/status`);
      console.log(`WebSocket: ws://127.0.0.1:${env.port}/ws`);
      console.log("========================================");
    });
  } catch (err) {
    console.error("[CONNECTO] Startup failed:", err.message);
    process.exit(1);
  }
}

start();
