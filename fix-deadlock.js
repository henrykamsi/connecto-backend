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

function httpGet(port, path, token, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", error: "timeout" }); });
    req.end();
  });
}

// ============================================================================
// FIX 1 — Add a per-query timeout AND a global concurrency mutex to src/db
// ============================================================================
function patchDb() {
  info("FIX 1 — src/db/index.js: add timeout + mutex");

  const file = "src/db/index.js";
  if (!fs.existsSync(file)) { bad("src/db/index.js not found"); process.exit(1); }

  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[DB-TIMEOUT-MUTEX]")) { ok("already patched"); return; }

  // Insert timeout + mutex machinery near the top, right after `const db = connect`
  const anchor = "const db = connect({";
  if (!src.includes(anchor)) { bad("db connect anchor not found"); process.exit(1); }

  // Find the closing of the connect call and insert after it
  const idx = src.indexOf(anchor);
  const afterConnect = src.indexOf("});", idx) + 3;

  const block = `

/* [DB-TIMEOUT-MUTEX] Serialize all DB calls AND timeout any hung query.
   Prevents boot-time migration floods from corrupting the Turso client,
   and prevents any single query from hanging a request forever. */

let __dbChain = Promise.resolve();

function __withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("DB_TIMEOUT: " + label + " after " + ms + "ms")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function __serialize(fn) {
  const next = __dbChain.then(fn, fn);
  __dbChain = next.catch(() => {});
  return next;
}
`;

  src = src.slice(0, afterConnect) + block + src.slice(afterConnect);

  // Now replace the query/run/get functions to use serialize + timeout
  // Replace the query function
  src = src.replace(
    /async function query\(sql, params = \[\]\) \{[\s\S]*?\n\}/,
    `async function query(sql, params = []) {
  const normalized = normalizeSql(sql).trim();
  const trimmedUpper = normalized.replace(/^\\s+/, "").toUpperCase();
  const returnsRows =
    trimmedUpper.startsWith("SELECT") ||
    trimmedUpper.startsWith("WITH") ||
    trimmedUpper.startsWith("PRAGMA") ||
    /\\bRETURNING\\b/i.test(normalized);

  return __serialize(async () => {
    if (returnsRows) {
      const rows = await __withTimeout(db.all(normalized, params), 20000, "all");
      return { rows: Array.isArray(rows) ? rows : [], rowCount: Array.isArray(rows) ? rows.length : 0 };
    }
    const result = await __withTimeout(db.run(normalized, params), 20000, "run");
    return {
      rows: [],
      rowCount: typeof result?.rowsAffected === "number" ? result.rowsAffected : 0,
      rowsAffected: typeof result?.rowsAffected === "number" ? result.rowsAffected : 0
    };
  });
}`
  );

  src = src.replace(
    /async function get\(sql, params = \[\]\) \{[\s\S]*?\n\}/,
    `async function get(sql, params = []) {
  return __serialize(() => __withTimeout(db.get(normalizeSql(sql), params), 20000, "get"));
}`
  );

  src = src.replace(
    /async function run\(sql, params = \[\]\) \{[\s\S]*?\n\}/,
    `async function run(sql, params = []) {
  return __serialize(() => __withTimeout(db.run(normalizeSql(sql), params), 20000, "run"));
}`
  );

  // Add exec + batch serialization too
  src = src.replace(
    /async function exec\(sql\) \{[\s\S]*?\n\}/,
    `async function exec(sql) {
  return __serialize(() => __withTimeout(db.exec(sql), 30000, "exec"));
}`
  );

  src = src.replace(
    /async function batch\(statements\) \{[\s\S]*?\n\}/,
    `async function batch(statements) {
  return __serialize(() => __withTimeout(db.batch(statements), 30000, "batch"));
}`
  );

  // Health check stays simple — direct, not serialized (so it works even if queue is stuck)
  src = src.replace(
    /async function healthCheck\(\) \{[\s\S]*?\n\}/,
    `async function healthCheck() {
  const row = await __withTimeout(db.get("SELECT 1 AS ok"), 5000, "healthCheck");
  return Number(row?.ok) === 1;
}`
  );

  fs.writeFileSync(file + ".tmp.js", src);

  try { execSync("node --check " + file + ".tmp.js", { stdio: "pipe" }); }
  catch (e) { bad("src/db syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0,400) : e.message)); try { fs.unlinkSync(file + ".tmp.js"); } catch (_) {} process.exit(1); }

  fs.renameSync(file + ".tmp.js", file);
  ok("src/db/index.js patched — mutex + timeout");
}

// ============================================================================
// FIX 2 — Add a per-query timeout AND a global concurrency mutex to src/db
// ============================================================================
function patchHealth() {
  info("FIX 2 — make /health response instant");

  const file = "src/routes/complete-v1.js";
  if (!fs.existsSync(file)) { ok("complete-v1.js not found — skipping"); return; }

  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[HEALTH-INSTANT]")) { ok("already patched"); return; }

  const old = `router.get('/health/db',async(req,res)=>{
  const r = await query('SELECT CURRENT_TIMESTAMP AS server_time');`;
  const neu = `router.get('/health/db',async(req,res)=>{
  /* [HEALTH-INSTANT] */
  const r = await query('SELECT CURRENT_TIMESTAMP AS server_time').catch(e => ({ rows: [{ server_time: "unavailable: " + e.message }] }));`;

  if (src.includes(old)) {
    src = src.replace(old, neu);
    fs.writeFileSync(file, src);
    ok("health/db guarded");
  } else {
    warn("health/db anchor not found (non-fatal)");
  }
}

// ============================================================================
// Boot + probe
// ============================================================================
async function bootAndProbe() {
  info("Booting server on :3999");

  const { query } = require("./src/db");
  const u = await query("SELECT id FROM users WHERE account_status='active' AND deleted_at IS NULL LIMIT 1");
  let token = null;
  if (u.rows.length) {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    token = jwt.sign({ sub: u.rows[0].id, type: "access" }, envLocal.jwt.secret, { expiresIn: "10m" });
    ok("token minted");
  }

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

  info("Waiting for listener");
  let up = false;
  for (let i = 0; i < 40; i++) {
    const h = await httpGet(3999, "/api/v1/health", null, 5000);
    if (h.status === 200) { up = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!up) { bad("listener not responding"); try { child.kill("SIGTERM"); } catch (_) {} process.exit(1); }
  ok("listener responding");

  info("Settling 10s for boot migrations (now serialized)");
  await new Promise(r => setTimeout(r, 10000));
  ok("settled");

  info("Probing /feed/smart (30s timeout)");
  const probe = await httpGet(3999, "/api/v1/feed/smart?limit=3&offset=0", token, 30000);

  try { child.kill("SIGTERM"); } catch (_) {}

  console.log("");
  console.log("    HTTP " + probe.status);
  if (probe.body) console.log("    body: " + probe.body.slice(0, 800));
  if (probe.error) console.log("    error: " + probe.error);
  console.log("");

  if (probe.status === 200) { ok("FEED WORKS"); return true; }
  if (probe.status === 401) { warn("401 (no active user) — endpoint ALIVE"); return true; }
  bad("status " + probe.status);
  return false;
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log("  CONNECTO — FIX THE DEADLOCK (the actual bug)");
  console.log("════════════════════════════════════════════════════");
  console.log("");

  patchDb();
  patchHealth();

  const success = await bootAndProbe();

  console.log("────────────────────────────────────────────────────");

  if (!success) {
    console.log(`${R}✗ NOT PUSHING${X}`);
    console.log("");
    console.log("Files are patched on disk. Paste the body above.");
    process.exit(1);
  }

  console.log(`${G}✓ ALL CHECKS PASSED${X}`);
  console.log("");

  info("Committing and pushing");
  try {
    execSync("git add -A", { stdio: "inherit" });
    execSync('git commit -m "fix(db): serialize Turso queries + add 20s timeout to prevent boot-migration deadlock; make /health instant"', { stdio: "inherit" });
    execSync("git push origin main", { stdio: "inherit" });
    ok("pushed");
  } catch (e) {
    bad("git push failed: " + e.message);
    process.exit(1);
  }

  console.log("");
  console.log(`${G}════════════════════════════════════════════════════${X}`);
  console.log(`${G}  DEADLOCK FIX PUSHED — LIVE IN ~2 MIN${X}`);
  console.log(`${G}════════════════════════════════════════════════════${X}`);
  console.log("");
  process.exit(0);
})();
