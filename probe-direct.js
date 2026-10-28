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

function httpGet(port, path, token, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body, ms: Date.now() - start }));
    });
    const start = Date.now();
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message, ms: Date.now() - start }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", error: "timeout", ms: Date.now() - start }); });
    req.end();
  });
}

// ============================================================================
// Inject a DIAGNOSTIC endpoint BEFORE every wrapper in server.js
// ============================================================================
function injectDiagnostic() {
  info("Injecting diagnostic endpoints before all middlewares");

  const file = "server.js";
  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[DIAG-DIRECT]")) { ok("already injected"); return; }

  // Insert AFTER server creation but BEFORE the first app.use()
  const anchor = 'app.disable("x-powered-by");';
  if (!src.includes(anchor)) { bad("anchor not found"); process.exit(1); }

  const block = `${anchor}

/* [DIAG-DIRECT] These bypass every wrapper to prove where the hang is */
app.get("/__diag/ping", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now(), note: "no wrappers, no DB" });
});

app.get("/__diag/db", async (req, res) => {
  const t = Date.now();
  try {
    const { query } = require("./src/db");
    const r = await query("SELECT 1 AS ok");
    res.status(200).json({ ok: true, rows: r.rows, ms: Date.now() - t });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, ms: Date.now() - t });
  }
});

app.get("/__diag/auth", (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ ok: false, error: "no token" });
    const jwt = require("jsonwebtoken");
    const env = require("./src/config/env");
    const p = jwt.verify(h.slice(7), env.jwt.secret);
    res.status(200).json({ ok: true, userId: p.sub });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

`;

  src = src.replace(anchor, block);
  fs.writeFileSync(file, src);
  try { execSync("node --check server.js", { stdio: "pipe" }); ok("server.js patched — diagnostics injected"); }
  catch (e) {
    bad("syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0,400) : e.message));
    execSync("git restore server.js", { stdio: "inherit" });
    process.exit(1);
  }
}

// ============================================================================
// Boot and run the diagnostic probes
// ============================================================================
async function run() {
  const { query } = require("./src/db");
  const u = await query("SELECT id FROM users WHERE account_status='active' AND deleted_at IS NULL LIMIT 1");
  let token = null;
  if (u.rows.length) {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    token = jwt.sign({ sub: u.rows[0].id, type: "access" }, envLocal.jwt.secret, { expiresIn: "10m" });
    ok("token minted");
  }

  info("Booting server on :3999");
  const child = spawn("node", ["server.js"], {
    env: Object.assign({}, process.env, { PORT: "3999" }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let booted = false;
  child.stdout.on("data", (d) => {
    const s = d.toString();
    if (s.includes("CONNECTO COMPLETE V1 ONLINE")) booted = true;
    // Don't spam output — only show key lines
    s.split("\n").forEach(line => {
      const t = line.trim();
      if (t.startsWith("[REQ]") || t.includes("DIAG") || t.includes("timeout")) {
        console.log("    " + line);
      }
    });
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (s.includes("Error") || s.includes("error")) console.log("    STDERR: " + s.trim());
  });

  for (let i = 0; i < 120 && !booted; i++) await new Promise(r => setTimeout(r, 500));
  if (!booted) { bad("boot timeout"); try { child.kill("SIGTERM"); } catch (_) {} process.exit(1); }
  ok("booted");

  // Wait for listener
  for (let i = 0; i < 40; i++) {
    const h = await httpGet(3999, "/__diag/ping", null, 3000);
    if (h.status === 200) break;
    await new Promise(r => setTimeout(r, 500));
  }
  ok("listener up");

  // Immediately probe — no settle delay
  console.log("");
  info("PROBE 1: /__diag/ping (no wrappers, no DB)");
  const p1 = await httpGet(3999, "/__diag/ping", null, 5000);
  console.log(`    status=${p1.status} ms=${p1.ms}`);
  if (p1.status === 200) ok("ping works");
  else bad(`ping failed: ${p1.error}`);

  info("PROBE 2: /__diag/auth (JWT verify only, no DB)");
  const p2 = await httpGet(3999, "/__diag/auth", token, 5000);
  console.log(`    status=${p2.status} ms=${p2.ms}`);
  if (p2.status === 200) ok("auth works");
  else bad(`auth failed: ${p2.error} | ${p2.body?.slice(0,100)}`);

  info("PROBE 3: /__diag/db (1 DB query, no wrappers)");
  const p3 = await httpGet(3999, "/__diag/db", null, 25000);
  console.log(`    status=${p3.status} ms=${p3.ms}`);
  if (p3.status === 200) {
    ok(`db works: ${p3.body.slice(0, 100)}`);
  } else {
    bad(`db failed: ${p3.error} | ${p3.body?.slice(0,200)}`);
  }

  info("PROBE 4: /api/v1/health (goes through wrappers, no DB)");
  const p4 = await httpGet(3999, "/api/v1/health", null, 10000);
  console.log(`    status=${p4.status} ms=${p4.ms}`);
  if (p4.status === 200) ok("health works");
  else bad(`health failed: ${p4.error}`);

  info("PROBE 5: /api/v1/feed/smart (goes through ALL 10 wrappers + 6 DB queries)");
  const p5 = await httpGet(3999, "/api/v1/feed/smart?limit=3", token, 30000);
  console.log(`    status=${p5.status} ms=${p5.ms}`);
  if (p5.status === 200) {
    ok(`feed works: ${p5.body.slice(0, 200)}`);
  } else if (p5.status === 500) {
    bad(`feed 500: ${p5.body?.slice(0,400)}`);
  } else {
    bad(`feed ${p5.status || "timeout"}: ${p5.error || p5.body?.slice(0,200)}`);
  }

  try { child.kill("SIGTERM"); } catch (_) {}

  console.log("");
  console.log("────────────────────────────────────────────────────");
  console.log("DIAGNOSTIC COMPLETE");
  console.log("The probe that FAILED tells us exactly where the deadlock is.");
  console.log("");
  console.log("Interpretation:");
  console.log("  PROBE 1 fails → server not accepting connections");
  console.log("  PROBE 2 fails → JWT verify issue");
  console.log("  PROBE 3 fails → DB layer (mutex/timeout) issue");
  console.log("  PROBE 4 fails → some middleware wrapper blocks res.json");
  console.log("  PROBE 5 fails (but 1-4 pass) → /feed/smart handler has the hang");
}

(async () => {
  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log("  DIAGNOSTIC — isolate where /feed/smart hangs");
  console.log("════════════════════════════════════════════════════");

  // Restore server.js from the deadlock patch so we test clean
  execSync("git restore server.js src/routes/smart-feed.js src/db/index.js src/routes/complete-v1.js 2>/dev/null || true", { stdio: "ignore" });

  injectDiagnostic();
  await run();
  process.exit(0);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
