const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");

const env = require("./src/config/env");
const { query } = require("./src/db");
const { attachRealtime } = require("./src/websocket/realtime");
const v1 = require("./src/routes/complete-v1");

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

app.use("/api/v1", v1);

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
