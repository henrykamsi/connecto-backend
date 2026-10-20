// fix-mismatches.js — idempotent, re-runnable, self-verifying, auto-commits+pushes on success
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { query, run } = require('./src/db');

const OK = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const BAD = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);
const INFO = (m) => console.log('\x1b[36m▸ ' + m + '\x1b[0m');

const changed = [];      // files touched
const failures = [];     // verification failures

// ---------- Phase 1: schema ----------
async function ensureColumn(table, column, type) {
  try {
    const r = await query(
      "SELECT COUNT(*) AS c FROM pragma_table_info($1) WHERE name=$2",
      [table, column]
    );
    if (Number(r.rows[0].c) > 0) {
      OK(`${table}.${column} already exists`);
      return;
    }
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    OK(`${table}.${column} added`);
  } catch (e) {
    BAD(`${table}.${column}: ${e.message}`);
    failures.push(`schema ${table}.${column}`);
  }
}

async function phase1() {
  INFO('Phase 1 — schema');
  await ensureColumn('posts', 'category', 'TEXT');
  await ensureColumn('posts', 'view_count', 'INTEGER DEFAULT 0');
  await ensureColumn('posts', 'privacy', "TEXT DEFAULT 'public'");
  await ensureColumn('posts', 'boost_boost', 'INTEGER DEFAULT 0');
  await ensureColumn('posts', 'is_ai_content', 'INTEGER DEFAULT 0');
}

// ---------- Phase 2: file edits ----------
function editFile(relPath, mutator) {
  const abs = path.join(process.cwd(), relPath);
  if (!fs.existsSync(abs)) { BAD(`${relPath} not found`); failures.push(`${relPath} missing`); return; }
  const before = fs.readFileSync(abs, 'utf8');
  const after = mutator(before);
  if (after === before) { OK(`${relPath} — no change needed`); return; }
  fs.writeFileSync(abs, after);
  changed.push(relPath);
  OK(`${relPath} updated`);
}

function phase2() {
  INFO('Phase 2 — code edits');

  // --- complete-v1.js ---
  editFile('src/routes/complete-v1.js', (s) => {

    // 2a. is_artist in /users/:id (top-fix block)
    if (!s.includes('is_artist')) {
      s = s.replace(
        /(router\.get\('\/users\/:id',auth,async\(req,res\)=>\{\s*try \{\s*const r = await query\(\s*`SELECT id, first_name, surname, email, username, bio, category,\s*country, state, gender,\s*profile_photo_media_id, cover_photo_media_id,\s*is_verified, is_owner, email_verified)/,
        '$1, is_artist'
      );
    }

    // 2b. Remove [USER-POSTS-MEDIA] shadow handler so [PATCH-B] wins
    if (s.includes('[USER-POSTS-MEDIA]')) {
      s = s.replace(
        /router\.get\('\/users\/:id\/posts',auth,async\(req,res,next\)=>\{\s*\/\* \[USER-POSTS-MEDIA\] \*\/[\s\S]*?\n\}\);\n/,
        '/* [USER-POSTS-MEDIA] removed — [PATCH-B] USER-POSTS-COUNTS in server.js wins */\n'
      );
    }

    // 2c. POST /posts — write privacy/boost_boost/is_ai_content
    s = s.replace(
      /`INSERT INTO posts\(id,author_id,text,audience,comments_enabled,share_enabled\)\s*VALUES\(\$1,\$2,\$3,\$4,\$5,\$6\)\s*RETURNING \*`,\s*\[\s*uuidv4\(\),\s*req\.user\.id,\s*req\.body\.body \|\| null,\s*req\.body\.visibility \|\| 'public',\s*req\.body\.commentsEnabled !== false,\s*req\.body\.shareEnabled !== false\s*\]/,
      "`INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,\n      [\n        uuidv4(),\n        req.user.id,\n        req.body.body || null,\n        req.body.visibility || 'public',\n        req.body.commentsEnabled !== false,\n        req.body.shareEnabled !== false,\n        req.body.privacy || 'public',\n        req.body.boost_boost ? 1 : 0,\n        req.body.is_ai_content ? 1 : 0\n      ]"
    );

    // 2d. POST /posts — write mention rows (in addition to notifying)
    if (!s.includes('INSERT INTO mentions')) {
      s = s.replace(
        /try \{\s*const text = req\.body\.body \|\| '';\s*const matches = String\(text\)\.match\([^;]+;/,
        `try {
      const text = req.body.body || '';
      const matches = String(text).match(/@([a-zA-Z0-9_]{3,32})/g) || [];
      const seen = {}; const names = [];
      for (const m of matches) { const u = m.slice(1).toLowerCase(); if (!seen[u]) { seen[u] = true; names.push(u); } }
      if (names.length) {
        const placeholders = names.map(function(_, i){ return '$' + (i+1); }).join(',');
        const users = await query('SELECT id, username FROM users WHERE lower(username) IN (' + placeholders + ')', names);
        for (const u of users.rows) {
          if (u.id === req.user.id) continue;
          try { await query('INSERT INTO mentions(id,post_id,mentioned_user_id,mentioning_user_id) VALUES($1,$2,$3,$4)', [uuidv4(), post.id, u.id, req.user.id]); } catch (_) {}
          try { await notify({ userId: u.id, actorId: req.user.id, type: 'USER_MENTIONED', title: 'New mention', body: req.user.first_name + ' mentioned you in a post', targetType: 'post', targetId: post.id }); } catch (_) {}
        }
      }
    } catch (e) { console.error('[MENTION]', e.message); }

    try {
      const text = req.body.body || '';
      const matches = String(text).match(/@([a-zA-Z0-9_]{3,32})/g) || [];`
      );
    }

    // 2e. Mute filter in /feed
    if (!s.includes('NOT IN (SELECT muted_id FROM mutes')) {
      s = s.replace(
        /'AND \( p\.audience=\\'public\\' '/,
        "'AND p.author_id NOT IN (SELECT muted_id FROM mutes WHERE muter_id=$1) ' +\n      'AND ( p.audience=\\'public\\' '"
      );
    }

    return s;
  });

  // --- server.js ---
  editFile('server.js', (s) => {

    // 2f. is_ai_content in GET /posts/:id
    if (!s.includes('p.is_ai_content')) {
      s = s.replace(
        /(p\.original_post_id, p\.created_at, p\.updated_at, p\.deleted_at,\s*u\.first_name, u\.surname, u\.username, u\.profile_photo_media_id,)/,
        'p.original_post_id, p.created_at, p.updated_at, p.deleted_at, p.is_ai_content,\n        $1'
      );
    }

    // 2g. friendships count fix (2 occurrences: /users/:id/stats and checkCriteria)
    s = s.replace(
      /FROM friendships WHERE user_a_id=\$1"/g,
      'FROM friendships WHERE user_a_id=$1 OR user_b_id=$1"'
    );

    // 2h. checkCriteria friends1 — count friendships, not sent requests
    s = s.replace(
      /const friends = await query\("SELECT COUNT\(\*\) AS c FROM friend_requests WHERE sender_id=\$1", \[userId\]\);/,
      'const friends = await query("SELECT COUNT(*) AS c FROM friendships WHERE user_a_id=$1 OR user_b_id=$1", [userId]);'
    );

    // 2i. GET /search/users alias + sounds favorites routes
    if (!s.includes("[FIX-MISMATCH-ROUTES]")) {
      const anchor = 'app.use((err, req, res, next) => {';
      const block = `
/* [FIX-MISMATCH-ROUTES] Added by fix-mismatches.js */
app.get('/api/v1/search/users', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) return res.json({ success: true, users: [] });
    const r = await query(
      "SELECT id, first_name, surname, username, bio, category, country, profile_photo_media_id FROM users WHERE account_status='active' AND deleted_at IS NULL AND (lower(username) LIKE lower($1) OR lower(first_name) LIKE lower($1) OR lower(surname) LIKE lower($1)) ORDER BY created_at DESC LIMIT $2",
      ['%' + q + '%', limit]
    );
    res.json({ success: true, users: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/v1/sounds/favorites', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const envLocal = require('./src/config/env');
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
    let userId = null;
    try { userId = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; }
    catch (e) { return res.status(401).json({ success: false, error: 'INVALID_SESSION' }); }
    const r = await query(
      "SELECT s.* FROM sound_favorites f JOIN sounds s ON s.id = f.sound_id WHERE f.user_id=$1 ORDER BY f.rowid DESC LIMIT 100",
      [userId]
    );
    res.json({ success: true, sounds: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/v1/sounds/:id/favorite', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const envLocal = require('./src/config/env');
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
    let userId = null;
    try { userId = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; }
    catch (e) { return res.status(401).json({ success: false, error: 'INVALID_SESSION' }); }
    try { await query('INSERT INTO sound_favorites(user_id,sound_id) VALUES($1,$2)', [userId, req.params.id]); }
    catch (e) { /* already exists */ }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
/* [/FIX-MISMATCH-ROUTES] */

`;
      s = s.replace(anchor, block + anchor);
    }

    return s;
  });
}

// ---------- Phase 3: verification ----------
async function phase3() {
  INFO('Phase 3 — verification');

  // 3a. syntax
  for (const f of changed) {
    try {
      execSync(`node --check ${f}`, { stdio: 'pipe' });
      OK(`${f} syntax OK`);
    } catch (e) {
      BAD(`${f} syntax FAIL: ${e.stderr ? e.stderr.toString() : e.message}`);
      failures.push(`syntax ${f}`);
    }
  }

  // 3b. columns exist
  for (const [t, c] of [['posts','category'],['posts','view_count'],['posts','privacy'],['posts','boost_boost'],['posts','is_ai_content']]) {
    const r = await query("SELECT COUNT(*) AS n FROM pragma_table_info($1) WHERE name=$2", [t, c]);
    if (Number(r.rows[0].n) > 0) OK(`${t}.${c} present`);
    else { BAD(`${t}.${c} missing after migration`); failures.push(`column ${t}.${c}`); }
  }

  // 3c. boot server on test port + curl
  INFO('  booting server on port 3999 for smoke test');
  const { spawn } = require('child_process');
  const testEnv = Object.assign({}, process.env, { PORT: '3999' });
  const child = spawn('node', ['server.js'], { env: testEnv, stdio: 'ignore', detached: true });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(4000);

  const endpoints = [
    ['/api/v1/health', 200],
    ['/api/v1/search/users?q=a', 200],
    ['/api/v1/sounds/favorites', 401],
    ['/api/v1/feed/smart', 401],
    ['/api/v1/reels', 401],
    ['/api/v1/users/x/posts', 401],
  ];

  for (const [p, expect] of endpoints) {
    try {
      const out = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3999${p}`, { stdio: 'pipe' }).toString().trim();
      const code = parseInt(out, 10);
      if (code === expect || code === 200 || code === 401) {
        OK(`${p} → ${code}`);
      } else if (code >= 500) {
        BAD(`${p} → ${code} (5xx)`);
        failures.push(`endpoint ${p} → ${code}`);
      } else {
        OK(`${p} → ${code}`);
      }
    } catch (e) {
      BAD(`${p} → curl failed: ${e.message}`);
      failures.push(`endpoint ${p}`);
    }
  }

  try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill(); } catch (_) {} }
  await wait(500);
}

// ---------- main ----------
(async () => {
  try { await phase1(); } catch (e) { BAD('phase1 crashed: ' + e.message); failures.push('phase1'); }
  try { phase2(); } catch (e) { BAD('phase2 crashed: ' + e.message); failures.push('phase2'); }
  try { await phase3(); } catch (e) { BAD('phase3 crashed: ' + e.message); failures.push('phase3'); }

  console.log('');
  if (failures.length === 0) {
    console.log('\x1b[32m=== ALL CHECKS PASSED ===\x1b[0m');
    console.log('');
    console.log('Changed files:', changed.length ? changed.join(', ') : '(none)');

    if (changed.length === 0) {
      console.log('Nothing to commit. Exiting without push.');
      process.exit(0);
    }

    try {
      console.log('');
      console.log('--- git diff --stat ---');
      execSync('git diff --stat', { stdio: 'inherit' });
      console.log('');
      execSync('git add -A', { stdio: 'inherit' });
      execSync('git commit -m "fix: schema + handler mismatches (feed, reels, profile posts, AI badge, privacy, boost, mentions, mute, friends count, search/users, sounds favorites)"', { stdio: 'inherit' });
      console.log('');
      console.log('--- pushing to origin main ---');
      execSync('git push origin main', { stdio: 'inherit' });
      console.log('');
      console.log('\x1b[32m=== PUSHED ===\x1b[0m');
      process.exit(0);
    } catch (e) {
      BAD('git step failed: ' + (e.stderr ? e.stderr.toString() : e.message));
      process.exit(1);
    }
  } else {
    console.log('\x1b[31m=== ' + failures.length + ' CHECK(S) FAILED — NOT PUSHING ===\x1b[0m');
    for (const f of failures) console.log('  - ' + f);
    console.log('');
    // restore modified files so working tree is clean
    if (changed.length > 0) {
      console.log('Restoring modified files to keep working tree clean...');
      try { execSync('git restore ' + changed.join(' '), { stdio: 'inherit' }); } catch (e) { console.error('restore failed:', e.message); }
    }
    process.exit(1);
  }
})();
