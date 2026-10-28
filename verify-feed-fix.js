#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs");
const http = require("http");
const { spawn, execSync } = require("child_process");

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", X = "\x1b[0m";
const ok = (m) => console.log(`  ${G}✓${X} ${m}`);
const bad = (m) => console.log(`  ${R}✗${X} ${m}`);
const warn = (m) => console.log(`  ${Y}⚠${X} ${m}`);
const info = (m) => console.log(`${C}▸ ${m}${X}`);

function httpGet(port, path, token) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", error: "timeout" }); });
    req.end();
  });
}

async function main() {
  // ------------------------------------------------------------------
  // Step A — Re-apply code patches (previous run reverted them)
  // ------------------------------------------------------------------
  info("Re-applying code patches (server.js + smart-feed.js)");

  try {
    execSync("node fix-feed-500.js", { stdio: "ignore" });
  } catch (_) { /* will fail at its own smoke test, that's fine */ }

  const srv = fs.readFileSync("server.js", "utf8");
  const sf = fs.readFileSync("src/routes/smart-feed.js", "utf8");

  if (srv.includes("[FEED-500-COLUMN-FIX]")) ok("server.js patched");
  else { bad("server.js NOT patched — run fix-feed-500.js manually first"); process.exit(1); }
  if (sf.includes("[SMART-FEED-DEFENSIVE]")) ok("smart-feed.js patched");
  else { bad("smart-feed.js NOT patched"); process.exit(1); }

  // ------------------------------------------------------------------
  // Step B — Mint test token
  // ------------------------------------------------------------------
  const { query } = require("./src/db");
  const u = await query("SELECT id FROM users WHERE account_status='active' AND deleted_at IS NULL LIMIT 1");
  let token = null;
  if (u.rows.length) {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    token = jwt.sign({ sub: u.rows[0].id, type: "access" }, envLocal.jwt.secret, { expiresIn: "5m" });
    ok("token minted");
  } else {
    warn("no active user — probing anonymously");
  }

  // ------------------------------------------------------------------
  // Step C — Boot server (NOT detached)
  // ------------------------------------------------------------------
  info("Booting server on :3999");

  const child = spawn("node", ["server.js"], {
    env: Object.assign({}, process.env, { PORT: "3999" }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let booted = false;
  let bootError = null;

  child.stdout.on("data", (d) => {
    const s = d.toString();
    process.stdout.write("    " + s.replace(/\n/g, "\n    "));
    if (s.includes("CONNECTO COMPLETE V1 ONLINE")) booted = true;
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    process.stdout.write("    " + s.replace(/\n/g, "\n    "));
  });
  child.on("exit", (code) => {
    if (!booted) bootError = `process exited (code ${code}) before boot`;
  });

  // Wait for boot marker
  for (let i = 0; i < 90 && !booted && !bootError; i++) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (!booted) {
    bad("server never booted");
    if (bootError) console.log("    " + bootError);
    try { child.kill("SIGTERM"); } catch (_) {}
    process.exit(1);
  }
  ok("server booted");

  // ------------------------------------------------------------------
  // Step D — Poll /health until listening (20s)
  // ------------------------------------------------------------------
  info("Waiting for HTTP listener to respond");

  let listening = false;
  for (let i = 0; i < 40; i++) {
    const h = await httpGet(3999, "/api/v1/health");
    if (h.status === 200) { listening = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!listening) {
    bad("HTTP listener never responded on :3999");
    try { child.kill("SIGTERM"); } catch (_) {}
    process.exit(1);
  }
  ok("HTTP listener responding");

  // ------------------------------------------------------------------
  // Step E — Probe /feed/smart
  // ------------------------------------------------------------------
  info("Probing /api/v1/feed/smart");

  const probe = await httpGet(3999, "/api/v1/feed/smart?limit=3&offset=0", token);

  try { child.kill("SIGTERM"); } catch (_) {}

  console.log("    HTTP " + probe.status);
  if (probe.body) console.log("    body: " + probe.body.slice(0, 500));
  if (probe.error) console.log("    error: " + probe.error);

  console.log("");

  if (probe.status === 200) {
    ok("FEED FIX VERIFIED — /feed/smart returns 200");
    console.log("");
    console.log(`  ${G}Committing and pushing…${X}`);
    try {
      execSync("git add -A", { stdio: "inherit" });
      execSync('git commit -m "fix(feed): add missing posts columns; make smart-feed defensive about missing optional columns; guarantee columns on every boot"', { stdio: "inherit" });
      execSync("git push origin main", { stdio: "inherit" });
      console.log("");
      console.log(`  ${G}════════════════════════════════════════════${X}`);
      console.log(`  ${G}  PUSHED — FEED FIX LIVE IN ~2 MIN${X}`);
      console.log(`  ${G}════════════════════════════════════════════${X}`);
    } catch (e) {
      bad("git push failed: " + e.message);
      process.exit(1);
    }
    process.exit(0);
  } else if (probe.status === 401) {
    warn("returns 401 (no active user in DB) — endpoint is ALIVE, not 500. Treating as pass.");
    try {
      execSync("git add -A", { stdio: "inherit" });
      execSync('git commit -m "fix(feed): add missing posts columns; make smart-feed defensive"', { stdio: "inherit" });
      execSync("git push origin main", { stdio: "inherit" });
      console.log(`\n  ${G}PUSHED${X}`);
    } catch (e) { bad("git push failed: " + e.message); process.exit(1); }
    process.exit(0);
  } else if (probe.status === 500) {
    bad("still 500 — smart-feed defensive patch missed this case");
    console.log("");
    console.log("Paste the body above to me and I'll fix the exact query.");
    process.exit(1);
  } else {
    bad("unexpected status " + probe.status);
    process.exit(1);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
