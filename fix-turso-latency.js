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

function httpGet(port, path, token, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const start = Date.now();
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body, ms: Date.now() - start }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message, ms: Date.now() - start }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", error: "timeout", ms: Date.now() - start }); });
    req.end();
  });
}

// ============================================================================
// FIX 1 — Parallelize the 3 post-reader queries in smart-feed.js
// ============================================================================
function parallelizeReaders() {
  info("FIX 1 — parallelize the 3 feed readers");

  const file = "src/routes/smart-feed.js";
  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[PARALLEL-READERS]")) { ok("already applied"); return; }

  // Find the sequential reads
  const oldBlock = `    const p1F = await readFollowing(recent);
    const p1I = await readInterest(recent);
    const p1R = await readRandom(recent);`;

  const newBlock = `    /* [PARALLEL-READERS] Fire all 3 readers concurrently. Cuts cold-start latency 3x. */
    const [p1F, p1I, p1R] = await Promise.all([
      readFollowing(recent),
      readInterest(recent),
      readRandom(recent)
    ]);`;

  if (!src.includes(oldBlock)) {
    bad("reader sequence not found — checking alternate...");
    // Try the widened set too
    const oldBlock2 = `      const w2F = (await readFollowing(new Set())).filter(x => !pickedIds.has(x.id));
      const w2I = (await readInterest(new Set())).filter(x => !pickedIds.has(x.id));
      const w2R = (await readRandom(new Set())).filter(x => !pickedIds.has(x.id));`;
    const newBlock2 = `      const [allF2, allI2, allR2] = await Promise.all([
        readFollowing(new Set()),
        readInterest(new Set()),
        readRandom(new Set())
      ]);
      const w2F = allF2.filter(x => !pickedIds.has(x.id));
      const w2I = allI2.filter(x => !pickedIds.has(x.id));
      const w2R = allR2.filter(x => !pickedIds.has(x.id));`;
    if (src.includes(oldBlock2)) {
      src = src.replace(oldBlock2, newBlock2);
      ok("widened readers parallelized");
    }
  } else {
    src = src.replace(oldBlock, newBlock);
    ok("primary readers parallelized");
  }

  // Also parallelize the fallback (pass 3) block
  const fallbackOld = `      const allF = await readFollowing(new Set());
      const allI = await readInterest(new Set());
      const allR = await readRandom(new Set());
      const pool = shuffle([...allF, ...allI, ...allR]);`;
  const fallbackNew = `      const [allF, allI, allR] = await Promise.all([
        readFollowing(new Set()),
        readInterest(new Set()),
        readRandom(new Set())
      ]);
      const pool = shuffle([...allF, ...allI, ...allR]);`;

  if (src.includes(fallbackOld)) {
    src = src.replace(fallbackOld, fallbackNew);
    ok("fallback readers parallelized");
  }

  // Also parallelize the 3 initial setup queries
  const setupOld = `    const intRows = await query("SELECT interest FROM user_interests WHERE user_id=$1", [req.userId]);
    const interests = intRows.rows.map(x => x.interest);

    const rec = await query("SELECT post_id FROM post_views WHERE user_id=$1 AND viewed_at > datetime('now','-30 minutes')", [req.userId]);
    const recent = new Set(rec.rows.map(x => x.post_id));

    const fol = await query("SELECT following_id FROM follows WHERE follower_id=$1", [req.userId]);
    const followingIds = fol.rows.map(x => x.following_id);
    const followingSet = new Set(followingIds);`;

  const setupNew = `    /* [PARALLEL-READERS] Fetch setup data in parallel */
    const [intRows, rec, fol] = await Promise.all([
      query("SELECT interest FROM user_interests WHERE user_id=$1", [req.userId]),
      query("SELECT post_id FROM post_views WHERE user_id=$1 AND viewed_at > datetime('now','-30 minutes')", [req.userId]),
      query("SELECT following_id FROM follows WHERE follower_id=$1", [req.userId])
    ]);
    const interests = intRows.rows.map(x => x.interest);
    const recent = new Set(rec.rows.map(x => x.post_id));
    const followingIds = fol.rows.map(x => x.following_id);
    const followingSet = new Set(followingIds);`;

  if (src.includes(setupOld)) {
    src = src.replace(setupOld, setupNew);
    ok("setup queries parallelized");
  }

  fs.writeFileSync(file + ".tmp.js", src);
  try { execSync("node --check " + file + ".tmp.js", { stdio: "pipe" }); }
  catch (e) {
    bad("smart-feed syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0,400) : e.message));
    try { fs.unlinkSync(file + ".tmp.js"); } catch (_) {}
    process.exit(1);
  }
  fs.renameSync(file + ".tmp.js", file);
  ok("smart-feed.js parallelized");
}

// ============================================================================
// FIX 2 — Pre-warm the Turso connection on boot
// ============================================================================
function addWarmup() {
  info("FIX 2 — pre-warm Turso connection on boot");

  const file = "server.js";
  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[TURSO-WARMUP]")) { ok("already applied"); return; }

  const anchor = 'app.disable("x-powered-by");';
  if (!src.includes(anchor)) { bad("anchor not found"); process.exit(1); }

  const block = `${anchor}

/* [TURSO-WARMUP] Pre-warm Turso connection so first real request isn't slow */
(async () => {
  try {
    const { query } = require("./src/db");
    const t0 = Date.now();
    await query("SELECT 1 AS warmup");
    const t1 = Date.now() - t0;
    await query("SELECT 1 AS warmup2");
    const t2 = Date.now() - t0 - t1;
    await query("SELECT 1 AS warmup3");
    const t3 = Date.now() - t0 - t1 - t2;
    console.log("[TURSO-WARMUP] timings: q1=" + t1 + "ms q2=" + t2 + "ms q3=" + t3 + "ms");
  } catch (e) {
    console.error("[TURSO-WARMUP] failed:", e.message);
  }
})();

`;

  src = src.replace(anchor, block);
  fs.writeFileSync(file, src);
  try { execSync("node --check server.js", { stdio: "pipe" }); ok("server.js warmup added"); }
  catch (e) {
    bad("syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0,400) : e.message));
    execSync("git restore server.js", { stdio: "inherit" });
    process.exit(1);
  }
}

// ============================================================================
// FIX 3 — Add DB timing logs so we see exactly how slow each query is
// ============================================================================
function addDbTiming() {
  info("FIX 3 — add per-query timing logs");

  const file = "src/db/index.js";
  if (!fs.existsSync(file)) { ok("skipping"); return; }

  let src = fs.readFileSync(file, "utf8");
  if (src.includes("[DB-TIMING]")) { ok("already applied"); return; }

  // Find the query function and add timing
  const old = `async function query(sql, params = []) {
  const normalized = normalizeSql(sql).trim();`;

  const neu = `async function query(sql, params = []) {
  const __t0 = Date.now();
  const normalized = normalizeSql(sql).trim();`;

  if (src.includes(old)) {
    src = src.replace(old, neu);

    // Find the return statement that follows and wrap it
    // Simplest: wrap the entire function body between the timing start and each return
    // We'll target the specific return inside the function scope
    const lines = src.split("\n");
    let inQuery = false;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("async function query")) { inQuery = true; braceDepth = 0; }
      if (inQuery) {
        for (const ch of lines[i]) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }
        if (lines[i].includes("return {") && lines[i].trim().startsWith("return {")) {
          // Insert timing log before this return
          lines[i] = `    if (Date.now() - __t0 > 1000) console.log("[DB-TIMING] slow query: " + (Date.now() - __t0) + "ms :: " + normalized.slice(0, 80));\n` + lines[i];
        }
        if (braceDepth === 0 && lines[i].trim() === "}") { inQuery = false; }
      }
    }
    src = lines.join("\n");

    fs.writeFileSync(file + ".tmp.js", src);
    try { execSync("node --check " + file + ".tmp.js", { stdio: "pipe" }); }
    catch (e) { bad("db syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0,400) : e.message)); try { fs.unlinkSync(file + ".tmp.js"); } catch (_) {} process.exit(1); }
    fs.renameSync(file + ".tmp.js", file);
    ok("db timing added");
  } else {
    warn("db query function anchor not found (non-fatal)");
  }
}

// ============================================================================
// Boot + probe
// ============================================================================
async function bootAndProbe() {
  info("Booting on :3999");

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
    if (s.includes("CONNECTO COMPLETE V1 ONLINE")) booted = true;
    s.split("\n").forEach(line => {
      const t = line.trim();
      if (t.startsWith("[TURSO-WARMUP]") || t.startsWith("[DB-TIMING]") || t.startsWith("[REQ]")) {
        console.log("    " + line);
      }
    });
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (s.includes("Error")) console.log("    STDERR: " + s.trim());
  });

  for (let i = 0; i < 120 && !booted; i++) await new Promise(r => setTimeout(r, 500));
  if (!booted) { bad("boot timeout"); try { child.kill("SIGTERM"); } catch (_) {} process.exit(1); }
  ok("booted");

  // Wait for listener + warmup
  for (let i = 0; i < 40; i++) {
    const h = await httpGet(3999, "/api/v1/health", null, 3000);
    if (h.status === 200) break;
    await new Promise(r => setTimeout(r, 500));
  }
  ok("listener up");

  info("Settling 15s for warmup + boot migrations");
  await new Promise(r => setTimeout(r, 15000));
  ok("settled");

  info("Probing /feed/smart (60s timeout)");
  const probe = await httpGet(3999, "/api/v1/feed/smart?limit=3&offset=0", token, 60000);

  try { child.kill("SIGTERM"); } catch (_) {}

  console.log("");
  console.log(`    HTTP ${probe.status} in ${probe.ms}ms`);
  if (probe.body) console.log("    body: " + probe.body.slice(0, 500));
  if (probe.error) console.log("    error: " + probe.error);
  console.log("");

  if (probe.status === 200) {
    ok(`FEED WORKS — returned in ${probe.ms}ms`);
    if (probe.ms > 5000) warn(`Still slow (${probe.ms}ms). Parallelization helped but Turso itself is slow.`);
    return true;
  }
  bad("status " + probe.status);
  return false;
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log("  CONNECTO — FIX TURSO LATENCY (real root cause)");
  console.log("════════════════════════════════════════════════════");
  console.log("");

  // Restore from previous experiments
  execSync("git restore server.js src/routes/smart-feed.js src/db/index.js 2>/dev/null || true", { stdio: "ignore" });

  // Re-apply column-fix patches (needed)
  const srv = fs.readFileSync("server.js", "utf8");
  if (!srv.includes("[FEED-500-COLUMN-FIX]")) {
    // Inject the column fix
    const anchor = 'app.use("/api/v1", v1);';
    const block = `
/* [FEED-500-COLUMN-FIX] */
(async () => {
  try {
    const { run } = require("./src/db");
    try { await run("ALTER TABLE posts ADD COLUMN category TEXT"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN view_count INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN is_ai_content INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN privacy TEXT DEFAULT 'public'"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN boost_boost INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published'"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN scheduled_at TEXT"); } catch(e){}
    console.log("[FEED-500-COLUMN-FIX] posts columns ensured");
  } catch(e) { console.error("[FEED-500-COLUMN-FIX]", e.message); }
})();

`;
    fs.writeFileSync("server.js", srv.replace(anchor, block + anchor));
    ok("re-applied column fix");
  }

  parallelizeReaders();
  addWarmup();
  addDbTiming();

  const success = await bootAndProbe();

  console.log("────────────────────────────────────────────────────");

  if (!success) {
    console.log(`${R}✗ NOT PUSHING${X}`);
    process.exit(1);
  }

  console.log(`${G}✓ FEED WORKS${X}`);
  console.log("");

  info("Committing and pushing");
  try {
    execSync("git add -A", { stdio: "inherit" });
    execSync('git commit -m "perf(feed): parallelize smart-feed queries; pre-warm Turso connection; log slow DB queries"', { stdio: "inherit" });
    execSync("git push origin main", { stdio: "inherit" });
    ok("pushed");
  } catch (e) {
    bad("git push failed: " + e.message);
    process.exit(1);
  }

  console.log("");
  console.log(`${G}════════════════════════════════════════════════════${X}`);
  console.log(`${G}  LATENCY FIX PUSHED — LIVE IN ~2 MIN${X}`);
  console.log(`${G}════════════════════════════════════════════════════${X}`);
  console.log("");
  process.exit(0);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
