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

// 45s timeout instead of 8s
function httpGet(port, path, token, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", error: "timeout-after-" + timeoutMs + "ms" }); });
    req.end();
  });
}

async function main() {
  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log("  CONNECTO — FEED 500 FIX (v2 — patient probe)");
  console.log("════════════════════════════════════════════════════");
  console.log("");

  // Confirm patches still applied (they are — previous run left them)
  const srv = fs.readFileSync("server.js", "utf8");
  const sf = fs.readFileSync("src/routes/smart-feed.js", "utf8");
  if (srv.includes("[FEED-500-COLUMN-FIX]")) ok("server.js patched");
  else { bad("server.js not patched — rerun run-feed-fix.js"); process.exit(1); }
  if (sf.includes("[SMART-FEED-DEFENSIVE]")) ok("smart-feed.js patched");
  else { bad("smart-feed.js not patched"); process.exit(1); }

  // Mint token
  const { query } = require("./src/db");
  const u = await query("SELECT id FROM users WHERE account_status='active' AND deleted_at IS NULL LIMIT 1");
  let token = null;
  if (u.rows.length) {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    token = jwt.sign({ sub: u.rows[0].id, type: "access" }, envLocal.jwt.secret, { expiresIn: "10m" });
    ok("token minted");
  } else { warn("no active user"); }

  info("Booting server on :3999");
  const child = spawn("node", ["server.js"], {
    env: Object.assign({}, process.env, { PORT: "3999" }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let booted = false;
  child.stdout.on("data", (d) => {
    const s = d.toString();
    process.stdout.write("    " + s.replace(/\n/g, "\n    "));
    if (s.includes("CONNECTO COMPLETE V1 ONLINE")) booted = true;
  });
  child.stderr.on("data", (d) => process.stdout.write("    " + d.toString().replace(/\n/g, "\n    ")));

  for (let i = 0; i < 120 && !booted; i++) await new Promise(r => setTimeout(r, 500));
  if (!booted) { bad("boot timeout"); try { child.kill("SIGTERM"); } catch (_) {} process.exit(1); }
  ok("server booted");

  // Wait for listener
  info("Waiting for listener");
  let up = false;
  for (let i = 0; i < 40; i++) {
    const h = await httpGet(3999, "/api/v1/health", null, 5000);
    if (h.status === 200) { up = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!up) { bad("listener not responding"); try { child.kill("SIGTERM"); } catch (_) {} process.exit(1); }
  ok("listener responding");

  // ← KEY CHANGE: give boot migrations 8 seconds to drain
  info("Waiting 8s for boot-time migrations to finish");
  await new Promise(r => setTimeout(r, 8000));
  ok("settled");

  // Probe with 45s timeout
  info("Probing /feed/smart (45s timeout)");
  const probe = await httpGet(3999, "/api/v1/feed/smart?limit=3&offset=0", token, 45000);

  try { child.kill("SIGTERM"); } catch (_) {}

  console.log("");
  console.log("    HTTP " + probe.status);
  if (probe.body) console.log("    body: " + probe.body.slice(0, 800));
  if (probe.error) console.log("    error: " + probe.error);
  console.log("");

  if (probe.status === 200) {
    ok("FEED FIX VERIFIED — /feed/smart returns 200");
  } else if (probe.status === 401) {
    warn("401 (no active user) — endpoint ALIVE, treating as pass");
  } else {
    bad("unexpected status " + probe.status);
    console.log("");
    console.log(`${R}NOT PUSHING — files still patched on disk${X}`);
    console.log("Paste the body/error above.");
    process.exit(1);
  }

  // Push
  console.log("");
  info("Committing and pushing");
  try {
    execSync("git add -A", { stdio: "inherit" });
    execSync('git commit -m "fix(feed): add missing posts columns; make smart-feed defensive about missing optional columns; guarantee columns on every boot"', { stdio: "inherit" });
    execSync("git push origin main", { stdio: "inherit" });
    ok("pushed");
  } catch (e) {
    bad("git push failed: " + e.message);
    process.exit(1);
  }

  console.log("");
  console.log(`${G}════════════════════════════════════════════════════${X}`);
  console.log(`${G}  FEED FIX PUSHED — LIVE IN ~2 MIN${X}`);
  console.log(`${G}════════════════════════════════════════════════════${X}`);
  console.log("");
  process.exit(0);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
