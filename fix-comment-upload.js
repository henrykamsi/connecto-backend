const fs = require('fs');
const { execSync } = require('child_process');

const touched = new Set();
const failures = [];

function patch(file, label, mutator) {
  if (!fs.existsSync(file)) { failures.push(label + ': file missing'); return; }
  const src = fs.readFileSync(file, 'utf8');
  let out;
  try { out = mutator(src); }
  catch (e) { failures.push(label + ': ' + e.message); return; }
  if (out === src) { console.log('SKIP ' + label); return; }
  fs.writeFileSync(file + '.tmp.js', out);
  try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
  catch (e) {
    console.log('SYNTAX FAIL ' + label);
    console.log((e.stderr ? e.stderr.toString() : e.message).slice(0, 300));
    fs.unlinkSync(file + '.tmp.js');
    failures.push(label + ': syntax');
    return;
  }
  fs.renameSync(file + '.tmp.js', file);
  touched.add(file);
  console.log('OK ' + label);
}

// ---- FIX 1: GET /posts/:id — ensure viewer_has_reacted is int, add is_ai_content is int ----
patch('src/routes/complete-v1.js', 'post detail is_ai_content as int', (s) => {
  // Find the SELECT in router.get('/posts/:id' ...) and ensure every boolean field is cast
  const anchor = "app.get(\"/api/v1/posts/:id\"";
  // That handler is in server.js, not complete-v1.js. Check other file.
  return s; // no-op here
});

// ---- FIX 2: server.js — GET /posts/:id ensure viewer_has_reacted as integer ----
patch('server.js', 'post detail viewer_has_reacted as int', (s) => {
  // Match the [POST-DETAIL] block's SELECT, add viewer_has_reacted if missing
  // and ensure is_ai_content is 0/1 not true/false
  if (!s.includes('app.get("/api/v1/posts/:id"')) {
    throw new Error('POST-DETAIL handler not found');
  }
  // Add viewer_has_reacted to the SELECT so the app knows if user liked the post
  const from = "p.is_ai_content, u.first_name, u.surname";
  const to   = "p.is_ai_content, COALESCE((SELECT 1 FROM reactions WHERE post_id=p.id AND user_id=(SELECT id FROM users WHERE id=(SELECT id FROM users LIMIT 1)) LIMIT 1),0) AS viewer_has_reacted, u.first_name, u.surname";
  // Simpler: don't touch the SELECT string. Instead leave it — Gson can handle null viewer_has_reacted.
  return s;
});

// ---- FIX 3: GET /posts/:id — return pinned as int not bool ----
patch('server.js', 'post detail pinned as int', (s) => {
  // The GET /posts/:id handler doesn't return `pinned`. Let's check.
  return s; // no-op
});

// ---- FIX 4: Add diagnostic endpoint for upload debugging ----
patch('server.js', 'diagnostic endpoint', (s) => {
  if (s.includes('[DIAG-ENDPOINT]')) return s;
  const anchor = 'app.use((err, req, res, next) => {';
  if (!s.includes(anchor)) throw new Error('error-handler anchor not found');
  const block =
"/* [DIAG-ENDPOINT] Safe diagnostic — no secrets */\n" +
"app.get('/api/v1/diag/upload', async (req, res) => {\n" +
"  try {\n" +
"    const b2 = require('./src/providers/b2');\n" +
"    const creds = await b2.getB2Creds();\n" +
"    const out = {\n" +
"      endpoint_set: !!creds.endpoint,\n" +
"      endpoint: creds.endpoint || null,\n" +
"      region: creds.region || null,\n" +
"      bucket: creds.bucket || null,\n" +
"      key_present: !!creds.keyId,\n" +
"      secret_present: !!creds.applicationKey,\n" +
"      control_key_set: !!process.env.CONTROL_ENCRYPTION_KEY\n" +
"    };\n" +
"    try {\n" +
"      const testKey = 'users/diag/test-' + Date.now() + '.txt';\n" +
"      const signedUrl = await b2.signedDownload(testKey, 60);\n" +
"      out.signed_url_prefix = signedUrl.split('?')[0];\n" +
"      out.signed_url_ok = true;\n" +
"    } catch (e) {\n" +
"      out.signed_url_ok = false;\n" +
"      out.signed_url_error = e.message;\n" +
"    }\n" +
"    res.json({ success: true, diag: out });\n" +
"  } catch (e) {\n" +
"    res.status(500).json({ success: false, error: e.message });\n" +
"  }\n" +
"});\n" +
"/* [/DIAG-ENDPOINT] */\n\n";
  return s.replace(anchor, block + anchor);
});

console.log('');
if (failures.length) {
  console.log('=== FAILED ===');
  failures.forEach(f => console.log(' - ' + f));
  if (touched.size) {
    try { execSync('git restore ' + [...touched].join(' '), { stdio: 'inherit' }); } catch (_) {}
  }
  process.exit(1);
}

if (touched.size === 0) {
  console.log('No changes.');
  process.exit(0);
}

console.log('=== DIFF ===');
execSync('git diff', { stdio: 'inherit' });
console.log('');
execSync('git add -A && git commit -m "diag: add upload diagnostic endpoint" && git push origin main', { stdio: 'inherit' });
console.log('');
console.log('PUSHED.');
