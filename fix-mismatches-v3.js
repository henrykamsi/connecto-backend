// fix-mismatches-v3.js — no auto-push. Prints diff. You run the push.
const fs = require('fs');
const { execSync } = require('child_process');

const OK = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const BAD = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);
const SKIP = (m) => console.log('  \x1b[33m⤼\x1b[0m ' + m);
const INFO = (m) => console.log('\x1b[36m▸ ' + m + '\x1b[0m');

const touched = new Set();
const failures = [];

function checkSyntax(file) {
  try {
    execSync('node --check "' + file + '"', { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const raw = (e.stderr ? e.stderr.toString() : e.message);
    const lines = raw.split('\n').filter(l => l.trim().length > 0).slice(0, 6).join('\n');
    return { ok: false, msg: lines };
  }
}

function applyEdit(file, label, mutator, { required = true } = {}) {
  if (!fs.existsSync(file)) { BAD(label + ': ' + file + ' missing'); failures.push(label); return; }
  const before = fs.readFileSync(file, 'utf8');
  let after;
  try {
    after = mutator(before);
  } catch (e) {
    if (required) { BAD(label + ': ' + e.message); failures.push(label); }
    else { SKIP(label + ': anchor missing (not required)'); }
    return;
  }
  if (after === before) { SKIP(label + ': already applied or no-op'); return; }

  // Write to a temp file that still ends in .js so node --check parses it
  const tmp = file + '.tmp.js';
  fs.writeFileSync(tmp, after);
  const syn = checkSyntax(tmp);
  if (!syn.ok) {
    BAD(label + ': temp syntax FAIL\n' + syn.msg);
    try { fs.unlinkSync(tmp); } catch (_) {}
    failures.push(label);
    return;
  }
  fs.renameSync(tmp, file);
  touched.add(file);
  OK(label);
}

// ---------- Edit 1: insert INTO mentions before the notify call in POST /posts ----------
INFO('Edit 1 — complete-v1.js: write mention rows to `mentions` table');
applyEdit('src/routes/complete-v1.js', 'mentions INSERT', (s) => {
  if (s.includes('INSERT INTO mentions')) return s;
  // Match the "New mention" body line, then walk back to the enclosing try { await notify({
  // Use the exact 5-line block from the file:
  //        for (const u of users.rows) {
  //          if (u.id === req.user.id) continue;
  //          try {
  //            await notify({
  const anchor =
    "        for (const u of users.rows) {\n" +
    "          if (u.id === req.user.id) continue;\n" +
    "          try {\n" +
    "            await notify({";
  if (!s.includes(anchor)) throw new Error('mention block anchor not found');
  const insertion =
    "        for (const u of users.rows) {\n" +
    "          if (u.id === req.user.id) continue;\n" +
    "          try {\n" +
    "            await query('INSERT INTO mentions(id,post_id,mentioned_user_id,mentioning_user_id) VALUES($1,$2,$3,$4)', [uuidv4(), post.id, u.id, req.user.id]);\n" +
    "          } catch (mentionsErr) { console.error('[MENTIONS-INSERT]', mentionsErr.message); }\n" +
    "          try {\n" +
    "            await notify({";
  return s.split(anchor).join(insertion);
});

// ---------- Edit 2: is_ai_content in GET /posts/:id ----------
INFO('Edit 2 — server.js: p.is_ai_content in GET /posts/:id');
applyEdit('server.js', 'is_ai_content in /posts/:id', (s) => {
  if (s.includes('p.is_ai_content, u.first_name')) return s;
  const anchor = 'p.original_post_id, p.created_at, p.updated_at, p.deleted_at, u.first_name, u.surname';
  if (!s.includes(anchor)) throw new Error('/posts/:id SELECT anchor not found');
  return s.split(anchor).join('p.original_post_id, p.created_at, p.updated_at, p.deleted_at, p.is_ai_content, u.first_name, u.surname');
}, { required: false });

// ---------- Edit 3: friendships count both sides ----------
INFO('Edit 3 — server.js: friendships count both sides');
applyEdit('server.js', 'friendships count both sides', (s) => {
  const before = 'FROM friendships WHERE user_a_id=$1"';
  if (!s.includes(before)) throw new Error('friendships anchor not found');
  return s.split(before).join('FROM friendships WHERE user_a_id=$1 OR user_b_id=$1"');
}, { required: false });

// ---------- Edit 4: checkCriteria friends1 ----------
INFO('Edit 4 — server.js: checkCriteria friends count');
applyEdit('server.js', 'checkCriteria friends', (s) => {
  const before = 'const friends = await query("SELECT COUNT(*) AS c FROM friend_requests WHERE sender_id=$1", [userId]);';
  if (!s.includes(before)) throw new Error('checkCriteria friends anchor not found');
  return s.split(before).join('const friends = await query("SELECT COUNT(*) AS c FROM friendships WHERE user_a_id=$1 OR user_b_id=$1", [userId]);');
}, { required: false });

// ---------- Edit 5: new routes ----------
INFO('Edit 5 — server.js: /search/users + /sounds/favorites');
applyEdit('server.js', 'search/users + sounds favorites', (s) => {
  if (s.includes('[FIX-MISMATCH-ROUTES]')) return s;
  const anchor = 'app.use((err, req, res, next) => {';
  if (!s.includes(anchor)) throw new Error('error-handler anchor not found');
  const block =
"/* [FIX-MISMATCH-ROUTES] */\n" +
"app.get('/api/v1/search/users', async (req, res) => {\n" +
"  try {\n" +
"    const q = String(req.query.q || '').trim();\n" +
"    const limit = Math.min(Number(req.query.limit || 20), 50);\n" +
"    if (!q) return res.json({ success: true, users: [] });\n" +
"    const r = await query(\"SELECT id, first_name, surname, username, bio, category, country, profile_photo_media_id FROM users WHERE account_status='active' AND deleted_at IS NULL AND (lower(username) LIKE lower($1) OR lower(first_name) LIKE lower($1) OR lower(surname) LIKE lower($1)) ORDER BY created_at DESC LIMIT $2\", ['%' + q + '%', limit]);\n" +
"    res.json({ success: true, users: r.rows });\n" +
"  } catch (e) { res.status(500).json({ success: false, error: e.message }); }\n" +
"});\n\n" +
"app.get('/api/v1/sounds/favorites', async (req, res) => {\n" +
"  try {\n" +
"    const jwt = require('jsonwebtoken');\n" +
"    const envLocal = require('./src/config/env');\n" +
"    const h = req.headers.authorization || '';\n" +
"    if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });\n" +
"    let userId = null;\n" +
"    try { userId = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; }\n" +
"    catch (e) { return res.status(401).json({ success: false, error: 'INVALID_SESSION' }); }\n" +
"    const r = await query('SELECT s.* FROM sound_favorites f JOIN sounds s ON s.id = f.sound_id WHERE f.user_id=$1 LIMIT 100', [userId]);\n" +
"    res.json({ success: true, sounds: r.rows });\n" +
"  } catch (e) { res.status(500).json({ success: false, error: e.message }); }\n" +
"});\n\n" +
"app.post('/api/v1/sounds/:id/favorite', async (req, res) => {\n" +
"  try {\n" +
"    const jwt = require('jsonwebtoken');\n" +
"    const envLocal = require('./src/config/env');\n" +
"    const h = req.headers.authorization || '';\n" +
"    if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });\n" +
"    let userId = null;\n" +
"    try { userId = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; }\n" +
"    catch (e) { return res.status(401).json({ success: false, error: 'INVALID_SESSION' }); }\n" +
"    try { await query('INSERT INTO sound_favorites(user_id,sound_id) VALUES($1,$2)', [userId, req.params.id]); } catch (_) {}\n" +
"    res.json({ success: true });\n" +
"  } catch (e) { res.status(500).json({ success: false, error: e.message }); }\n" +
"});\n" +
"/* [/FIX-MISMATCH-ROUTES] */\n\n";
  return s.split(anchor).join(block + anchor);
}, { required: false });

// ---------- Final gate: no auto-push ----------
console.log('');
if (failures.length > 0) {
  console.log('\x1b[31m=== ' + failures.length + ' FAILURE(S) ===\x1b[0m');
  for (const f of failures) console.log('  - ' + f);
  if (touched.size > 0) {
    console.log('Restoring: ' + Array.from(touched).join(' '));
    try { execSync('git restore ' + Array.from(touched).join(' '), { stdio: 'inherit' }); } catch (_) {}
  }
  process.exit(1);
}

if (touched.size === 0) {
  console.log('No files changed. Nothing to push.');
  process.exit(0);
}

console.log('\x1b[32m=== ALL CHECKS PASSED ===\x1b[0m');
console.log('Files changed: ' + Array.from(touched).join(', '));
console.log('');
console.log('--- git diff --stat ---');
execSync('git diff --stat', { stdio: 'inherit' });
console.log('');
console.log('--- git diff (full) ---');
execSync('git diff', { stdio: 'inherit' });
console.log('');
console.log('\x1b[33m=== NOT PUSHED — review the diff above ===\x1b[0m');
console.log('');
console.log('If the diff looks correct, run:');
console.log('  git add -A && git commit -m "fix: mentions insert, is_ai_content in post detail, friends count both sides, search/users alias, sounds favorites" && git push origin main');
console.log('');
console.log('If something looks wrong, revert with:');
console.log('  git restore server.js src/routes/complete-v1.js');
