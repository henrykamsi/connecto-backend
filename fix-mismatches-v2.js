// fix-mismatches-v2.js — minimal, safe, one-liner insertions only.
const fs = require('fs');
const { execSync } = require('child_process');

const OK = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const BAD = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);
const INFO = (m) => console.log('\x1b[36m▸ ' + m + '\x1b[0m');

const touched = [];
const failures = [];

function checkSyntax(file) {
  try {
    execSync('node --check ' + file, { stdio: 'pipe' });
    OK(file + ' syntax OK');
    return true;
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString().split('\n').slice(0, 4).join('\n') : e.message;
    BAD(file + ' syntax FAIL\n' + msg);
    failures.push('syntax ' + file);
    return false;
  }
}

function applyEdit(file, label, mutator) {
  if (!fs.existsSync(file)) { BAD(file + ' not found'); failures.push('missing ' + file); return; }
  const before = fs.readFileSync(file, 'utf8');
  const after = mutator(before);
  if (after === before) { OK(label + ' (already applied)'); return; }
  // Write to a temp file first, syntax check, only then commit
  const tmp = file + '.fixv2tmp';
  fs.writeFileSync(tmp, after);
  if (!checkSyntax(tmp)) {
    fs.unlinkSync(tmp);
    return;
  }
  fs.unlinkSync(tmp);
  fs.writeFileSync(file, after);
  touched.push(file);
  OK(label);
}

// ---------- Edit 1: complete-v1.js — insert INSERT INTO mentions ----------
INFO('Edit 1 — complete-v1.js: write mention rows');

applyEdit('src/routes/complete-v1.js', 'mentions insert added', (s) => {
  if (s.includes('INSERT INTO mentions')) { return s; }   // already there
  // The existing loop is:
  //   for (const u of users.rows) {
  //     if (u.id === req.user.id) continue;
  //     try {
  //       await notify({ ... });
  // We insert the DB write right before the try { await notify
  const anchor =
    "        for (const u of users.rows) {\n" +
    "          if (u.id === req.user.id) continue;\n" +
    "          try {\n" +
    "            await notify({";
  const replacement =
    "        for (const u of users.rows) {\n" +
    "          if (u.id === req.user.id) continue;\n" +
    "          try {\n" +
    "            await query('INSERT INTO mentions(id,post_id,mentioned_user_id,mentioning_user_id) VALUES($1,$2,$3,$4)', [uuidv4(), post.id, u.id, req.user.id]);\n" +
    "          } catch (_) {}\n" +
    "          try {\n" +
    "            await notify({";
  if (!s.includes(anchor)) { throw new Error('mention anchor not found'); }
  return s.split(anchor).join(replacement);
});

// ---------- Edit 2: server.js — add p.is_ai_content to /posts/:id SELECT ----------
INFO('Edit 2 — server.js: p.is_ai_content in GET /posts/:id');

applyEdit('server.js', 'is_ai_content added to /posts/:id', (s) => {
  const anchor = 'p.original_post_id, p.created_at, p.updated_at, p.deleted_at, u.first_name, u.surname';
  const replacement = 'p.original_post_id, p.created_at, p.updated_at, p.deleted_at, p.is_ai_content, u.first_name, u.surname';
  if (s.includes('p.is_ai_content, u.first_name')) { return s; }   // already there
  if (!s.includes(anchor)) { throw new Error('/posts/:id SELECT anchor not found'); }
  return s.split(anchor).join(replacement);
});

// ---------- Edit 3: server.js — friendships count fix ----------
INFO('Edit 3 — server.js: friendships count (both sides)');

applyEdit('server.js', 'friendships count fixed', (s) => {
  const before = 'FROM friendships WHERE user_a_id=$1"';
  const after  = 'FROM friendships WHERE user_a_id=$1 OR user_b_id=$1"';
  if (!s.includes(before)) { return s; }   // already applied or anchor not present
  return s.split(before).join(after);
});

// ---------- Edit 4: server.js — checkCriteria friends1 fix ----------
INFO('Edit 4 — server.js: checkCriteria friends count');

applyEdit('server.js', 'checkCriteria friends fixed', (s) => {
  const before = 'const friends = await query("SELECT COUNT(*) AS c FROM friend_requests WHERE sender_id=$1", [userId]);';
  const after  = 'const friends = await query("SELECT COUNT(*) AS c FROM friendships WHERE user_a_id=$1 OR user_b_id=$1", [userId]);';
  if (!s.includes(before)) { return s; }
  return s.split(before).join(after);
});

// ---------- Edit 5: server.js — GET /search/users + sounds favorites ----------
INFO('Edit 5 — server.js: /search/users alias + /sounds/favorites routes');

applyEdit('server.js', 'missing routes added', (s) => {
  if (s.includes('[FIX-MISMATCH-ROUTES]')) { return s; }
  const anchor = 'app.use((err, req, res, next) => {';
  if (!s.includes(anchor)) { throw new Error('error-handler anchor not found'); }
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
});

// ---------- Final gate ----------
console.log('');
if (failures.length > 0) {
  console.log('\x1b[31m=== FAILED — NOT PUSHING ===\x1b[0m');
  for (const f of failures) console.log('  - ' + f);
  if (touched.length) {
    console.log('Restoring: ' + touched.join(', '));
    try { execSync('git restore ' + touched.join(' '), { stdio: 'inherit' }); } catch (_) {}
  }
  process.exit(1);
}

if (touched.length === 0) {
  console.log('No files needed changing. Nothing to push.');
  process.exit(0);
}

console.log('\x1b[32m=== ALL CHECKS PASSED ===\x1b[0m');
console.log('Files changed: ' + touched.join(', '));
console.log('');
console.log('--- git diff --stat ---');
execSync('git diff --stat', { stdio: 'inherit' });
console.log('');
execSync('git add -A', { stdio: 'inherit' });
execSync('git commit -m "fix: mentions insert, is_ai_content in post detail, friends count both sides, search/users alias, sounds favorites"', { stdio: 'inherit' });
console.log('');
console.log('--- pushing to origin main ---');
execSync('git push origin main', { stdio: 'inherit' });
console.log('');
console.log('\x1b[32m=== PUSHED ===\x1b[0m');
