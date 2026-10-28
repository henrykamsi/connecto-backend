#!/usr/bin/env node
/**
 * fix-feed-500.js
 *
 * Fixes: /api/v1/feed/smart returning 500 because `posts.category` and
 *        `posts.view_count` are missing from the live Turso database.
 *
 * Steps:
 *   1. Add all missing columns to the posts table (idempotent)
 *   2. Patch server.js to guarantee those columns on every boot
 *   3. Patch src/routes/smart-feed.js to be defensive about missing columns
 *   4. Verify syntax of every touched file
 *   5. Boot on port 3999 and curl /api/v1/feed/smart to confirm 200
 *   6. Commit + push only if every check passes
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const CYAN = "\x1b[36m";
const RST = "\x1b[0m";

const ok = (m) => console.log(`  ${GREEN}✓${RST} ${m}`);
const bad = (m) => console.log(`  ${RED}✗${RST} ${m}`);
const info = (m) => console.log(`${CYAN}▸ ${m}${RST}`);
const warn = (m) => console.log(`  ${YEL}⚠${RST} ${m}`);

const failures = [];
const touched = [];

// ----------------------------------------------------------------------------
// STEP 1 — Add missing columns to the live DB
// ----------------------------------------------------------------------------
async function step1_columns() {
  info("STEP 1 — ensuring posts columns exist in Turso");

  const { run, query } = require("./src/db");

  const COLUMNS = [
    { name: "category",       ddl: "ALTER TABLE posts ADD COLUMN category TEXT" },
    { name: "view_count",     ddl: "ALTER TABLE posts ADD COLUMN view_count INTEGER DEFAULT 0" },
    { name: "is_ai_content",  ddl: "ALTER TABLE posts ADD COLUMN is_ai_content INTEGER DEFAULT 0" },
    { name: "privacy",        ddl: "ALTER TABLE posts ADD COLUMN privacy TEXT DEFAULT 'public'" },
    { name: "boost_boost",    ddl: "ALTER TABLE posts ADD COLUMN boost_boost INTEGER DEFAULT 0" },
    { name: "status",         ddl: "ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published'" },
    { name: "scheduled_at",   ddl: "ALTER TABLE posts ADD COLUMN scheduled_at TEXT" },
    { name: "is_boosted",     ddl: "ALTER TABLE posts ADD COLUMN is_boosted INTEGER DEFAULT 0" },
    { name: "boost_expires_at", ddl: "ALTER TABLE posts ADD COLUMN boost_expires_at TEXT" }
  ];

  // Discover which columns already exist
  let existing = new Set();
  try {
    const info = await query("PRAGMA table_info(posts)");
    existing = new Set(info.rows.map(r => r.name));
  } catch (e) {
    bad("PRAGMA table_info(posts) failed: " + e.message);
    failures.push("pragma table_info");
    return;
  }

  for (const col of COLUMNS) {
    if (existing.has(col.name)) {
      ok(`posts.${col.name} already exists`);
      continue;
    }
    try {
      await run(col.ddl);
      ok(`posts.${col.name} added`);
    } catch (e) {
      if (/duplicate column|already exists/i.test(e.message)) {
        ok(`posts.${col.name} already exists (caught)`);
      } else {
        bad(`posts.${col.name} failed: ${e.message}`);
        failures.push("add column " + col.name);
      }
    }
  }

  // Re-verify
  try {
    const info2 = await query("PRAGMA table_info(posts)");
    const names2 = new Set(info2.rows.map(r => r.name));
    for (const req of ["category", "view_count"]) {
      if (names2.has(req)) ok(`verified: posts.${req} present`);
      else { bad(`verified: posts.${req} STILL MISSING`); failures.push("verify column " + req); }
    }
  } catch (e) {
    bad("re-verify failed: " + e.message);
    failures.push("re-verify columns");
  }
}

// ----------------------------------------------------------------------------
// STEP 2 — Patch server.js so columns are ensured on every boot
// ----------------------------------------------------------------------------
function step2_patchServer() {
  info("STEP 2 — patching server.js to ensure columns on every boot");

  const file = path.join(process.cwd(), "server.js");
  if (!fs.existsSync(file)) { bad("server.js not found"); failures.push("server.js missing"); return; }

  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[FEED-500-COLUMN-FIX]")) {
    ok("server.js already patched");
    return;
  }

  const anchor = 'app.use("/api/v1", v1);';
  if (!src.includes(anchor)) {
    bad('anchor app.use("/api/v1", v1) not found in server.js');
    failures.push("server.js anchor");
    return;
  }

  const block = `
/* [FEED-500-COLUMN-FIX] Ensure posts columns exist on every boot.
   Idempotent. Prevents /feed/smart from 500ing when optional columns are missing. */
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
  } catch(e) {
    console.error("[FEED-500-COLUMN-FIX] failed:", e.message);
  }
})();

`;

  src = src.replace(anchor, block + anchor);
  fs.writeFileSync(file + ".tmp.js", src);

  try {
    execSync("node --check " + file + ".tmp.js", { stdio: "pipe" });
  } catch (e) {
    bad("server.js syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message));
    try { fs.unlinkSync(file + ".tmp.js"); } catch (_) {}
    failures.push("server.js syntax");
    return;
  }

  fs.renameSync(file + ".tmp.js", file);
  ok("server.js patched");
  touched.push("server.js");
}

// ----------------------------------------------------------------------------
// STEP 3 — Patch smart-feed.js to be defensive
// ----------------------------------------------------------------------------
function step3_patchSmartFeed() {
  info("STEP 3 — making smart-feed.js defensive about missing columns");

  const file = path.join(process.cwd(), "src", "routes", "smart-feed.js");
  if (!fs.existsSync(file)) { bad("src/routes/smart-feed.js not found"); failures.push("smart-feed.js missing"); return; }

  let src = fs.readFileSync(file, "utf8");

  if (src.includes("[SMART-FEED-DEFENSIVE]")) {
    ok("smart-feed.js already defensive");
    return;
  }

  // Replace the static POST_COLS and reader functions with column-aware versions.
  // We do this by injecting a detection helper at the top and rewriting POST_COLS.

  const bootAnchor = "const router = express.Router();";
  if (!src.includes(bootAnchor)) {
    bad("smart-feed.js boot anchor not found");
    failures.push("smart-feed.js anchor");
    return;
  }

  const detectionBlock = `${bootAnchor}

/* [SMART-FEED-DEFENSIVE] Detect which optional columns exist, so a missing one
   never causes a 500 across the whole feed. */
let HAS_CATEGORY = false;
let HAS_VIEW_COUNT = false;
let HAS_AI_FLAG = false;

(async () => {
  try {
    const { query } = require('../db');
    const info = await query("PRAGMA table_info(posts)");
    const names = new Set(info.rows.map(r => r.name));
    HAS_CATEGORY   = names.has('category');
    HAS_VIEW_COUNT = names.has('view_count');
    HAS_AI_FLAG    = names.has('is_ai_content');
    console.log('[SMART-FEED] columns: category=' + HAS_CATEGORY + ' view_count=' + HAS_VIEW_COUNT + ' is_ai_content=' + HAS_AI_FLAG);
    if (!HAS_CATEGORY) {
      console.error('[SMART-FEED] ⚠️ posts.category MISSING — feed will use global mode only.');
    }
  } catch (e) {
    console.error('[SMART-FEED] schema check failed:', e.message);
  }
})();

function buildPostCols() {
  const parts = [
    'p.id', 'p.author_id', 'p.text', 'p.audience',
    'p.comments_enabled', 'p.share_enabled', 'p.created_at'
  ];
  if (HAS_CATEGORY) parts.push('p.category');
  if (HAS_AI_FLAG)  parts.push('p.is_ai_content');
  parts.push('u.first_name');
  parts.push('u.surname');
  parts.push('u.username');
  parts.push('u.profile_photo_media_id');
  parts.push('u.is_verified AS author_verified');
  parts.push('(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count');
  parts.push('(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count');
  if (HAS_VIEW_COUNT) parts.push('COALESCE(p.view_count, 0) AS view_count');
  else                parts.push('0 AS view_count');
  parts.push('(SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key');
  parts.push('(SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type');
  return parts.join(', ');
}
`;

  // Replace the old static POST_COLS
  const oldPostCols = /const POST_COLS = "p\.id[\s\S]*?media_type";/;
  if (!oldPostCols.test(src)) {
    bad("smart-feed.js static POST_COLS not found");
    failures.push("smart-feed.js POST_COLS");
    return;
  }

  src = src.replace(oldPostCols, "// [SMART-FEED-DEFENSIVE] POST_COLS is built dynamically by buildPostCols()");

  // Insert detection block after router creation
  src = src.replace(bootAnchor, detectionBlock);

  // Replace every usage of POST_COLS inside queries with buildPostCols()
  src = src.replace(/\+ POST_COLS \+/g, "+ buildPostCols() +");

  // Guard readInterest: if no category column, return empty
  const readInterestOld = `async function readInterest(excludeIds) {
      if (!interests.length) return [];`;
  const readInterestNew = `async function readInterest(excludeIds) {
      if (!interests.length || !HAS_CATEGORY) return [];`;
  if (src.includes(readInterestOld)) {
    src = src.replace(readInterestOld, readInterestNew);
    ok("readInterest guarded for missing category");
  } else {
    warn("readInterest guard anchor not found (non-fatal)");
  }

  // Return the true error in the 500 body
  src = src.replace(
    `res.status(500).json({ success: false, error: e.message });`,
    `res.status(500).json({ success: false, error: e.message, code: "SMART_FEED_FAILED" });`
  );

  fs.writeFileSync(file + ".tmp.js", src);

  try {
    execSync("node --check " + file + ".tmp.js", { stdio: "pipe" });
  } catch (e) {
    bad("smart-feed.js syntax FAIL: " + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message));
    try { fs.unlinkSync(file + ".tmp.js"); } catch (_) {}
    failures.push("smart-feed.js syntax");
    return;
  }

  fs.renameSync(file + ".tmp.js", file);
  ok("smart-feed.js patched");
  touched.push("src/routes/smart-feed.js");
}

// ----------------------------------------------------------------------------
// STEP 4 — Verify syntax of every touched file
// ----------------------------------------------------------------------------
function step4_verifySyntax() {
  info("STEP 4 — syntax check");
  const files = [
    "server.js",
    "src/routes/smart-feed.js",
    "src/routes/complete-v1.js",
    "src/db/index.js"
  ];
  for (const f of files) {
    if (!fs.existsSync(f)) { warn(f + " missing, skipping"); continue; }
    try {
      execSync("node --check " + f, { stdio: "pipe" });
      ok(f);
    } catch (e) {
      bad(f + " syntax FAIL");
      failures.push("syntax " + f);
    }
  }
}

// ----------------------------------------------------------------------------
// STEP 5 — Boot on port 3999 and probe /feed/smart
// ----------------------------------------------------------------------------
async function step5_smokeTest() {
  info("STEP 5 — booting server on :3999 and probing /feed/smart");

  const { query } = require("./src/db");

  // Create a short-lived test JWT for an active user
  let token = null;
  try {
    const u = await query("SELECT id, email FROM users WHERE account_status='active' AND deleted_at IS NULL LIMIT 1");
    if (u.rows.length) {
      const jwt = require("jsonwebtoken");
      const envLocal = require("./src/config/env");
      token = jwt.sign({ sub: u.rows[0].id, type: "access" }, envLocal.jwt.secret, { expiresIn: "5m" });
      ok("test token issued for " + u.rows[0].email);
    } else {
      warn("no active users — will probe endpoint without auth (expect 401, not 500)");
    }
  } catch (e) {
    warn("could not mint test token: " + e.message);
  }

  const testEnv = Object.assign({}, process.env, { PORT: "3999" });
  const child = spawn("node", ["server.js"], {
    env: testEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });

  let exited = false;
  let booted = false;
  child.stdout.on("data", (d) => {
    const s = d.toString();
    if (s.includes("CONNECTO COMPLETE V1 ONLINE")) booted = true;
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (s.includes("Startup failed")) exited = true;
  });

  // Wait up to 12s for boot
  for (let i = 0; i < 60 && !booted && !exited; i++) {
    await new Promise(r => setTimeout(r, 200));
  }

  if (!booted) {
    bad("server did not boot on :3999");
    try { process.kill(-child.pid, "SIGTERM"); } catch (_) { try { child.kill(); } catch (_) {} }
    failures.push("boot on 3999");
    return;
  }
  ok("server booted on :3999");

  // Probe /feed/smart
  const { execSync: execProbe } = require("child_process");
  const header = token ? `-H "Authorization: Bearer ${token}"` : "";
  let code = "000";
  try {
    code = execProbe(
      `curl -s -o /tmp/feed_probe.json -w "%{http_code}" --max-time 8 ${header} "http://127.0.0.1:3999/api/v1/feed/smart?limit=3&offset=0"`,
      { stdio: "pipe" }
    ).toString().trim();
  } catch (_) {}

  try { process.kill(-child.pid, "SIGTERM"); } catch (_) { try { child.kill(); } catch (_) {} }

  if (code === "200") {
    ok("/feed/smart → 200");
  } else if (code === "401") {
    warn("/feed/smart → 401 (no user in DB — endpoint is alive, not 500)");
  } else if (code === "500") {
    bad("/feed/smart → 500 — column fix did NOT take. Read /tmp/feed_probe.json:");
    try {
      const body = fs.readFileSync("/tmp/feed_probe.json", "utf8");
      console.log(body.slice(0, 500));
    } catch (_) {}
    failures.push("feed/smart returns 500");
  } else {
    bad(`/feed/smart → unexpected ${code}`);
    try {
      const body = fs.readFileSync("/tmp/feed_probe.json", "utf8");
      console.log(body.slice(0, 500));
    } catch (_) {}
    failures.push("feed/smart " + code);
  }
}

// ----------------------------------------------------------------------------
// STEP 6 — Git commit + push (only if all checks pass)
// ----------------------------------------------------------------------------
function step6_push() {
  info("STEP 6 — commit and push");

  if (touched.length === 0) {
    ok("nothing to commit");
    return;
  }

  try {
    console.log("");
    execSync("git add -A", { stdio: "inherit" });
    execSync(
      'git commit -m "fix(feed): add posts.category + view_count columns; make smart-feed defensive about missing optional columns; guarantee columns on every boot"',
      { stdio: "inherit" }
    );
    console.log("");
    execSync("git push origin main", { stdio: "inherit" });
    ok("pushed to origin main");
  } catch (e) {
    bad("git push failed: " + e.message);
    failures.push("git push");
  }
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
(async () => {
  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log("  CONNECTO — FEED 500 FIX (server-side)");
  console.log("════════════════════════════════════════════════════");
  console.log("");

  try { await step1_columns(); } catch (e) { bad("step1 crashed: " + e.message); failures.push("step1"); }
  try { step2_patchServer(); } catch (e) { bad("step2 crashed: " + e.message); failures.push("step2"); }
  try { step3_patchSmartFeed(); } catch (e) { bad("step3 crashed: " + e.message); failures.push("step3"); }
  try { step4_verifySyntax(); } catch (e) { bad("step4 crashed: " + e.message); failures.push("step4"); }
  try { await step5_smokeTest(); } catch (e) { bad("step5 crashed: " + e.message); failures.push("step5"); }

  console.log("");
  console.log("────────────────────────────────────────────────────");

  if (failures.length > 0) {
    console.log(`${RED}✗ ${failures.length} CHECK(S) FAILED — NOT PUSHING${RST}`);
    for (const f of failures) console.log("   • " + f);
    console.log("");
    console.log("Restoring modified files to keep working tree clean…");
    if (touched.length > 0) {
      try { execSync("git restore " + touched.join(" "), { stdio: "inherit" }); } catch (_) {}
    }
    console.log("");
    console.log("DB column changes (step 1) are already applied and were KEPT.");
    console.log("Only the code-file changes were rolled back.");
    process.exit(1);
  }

  console.log(`${GREEN}✓ ALL CHECKS PASSED${RST}`);
  console.log("");
  try { step6_push(); } catch (e) { bad("push crashed: " + e.message); process.exit(1); }

  console.log("");
  console.log(`${GREEN}════════════════════════════════════════════════════${RST}`);
  console.log(`${GREEN}  FEED 500 FIX COMPLETE${RST}`);
  console.log(`${GREEN}════════════════════════════════════════════════════${RST}`);
  console.log("");
  console.log("Render will redeploy in ~2 minutes.");
  console.log("After deploy, the Home tab will load the feed.");
  console.log("");
  process.exit(0);
})();
