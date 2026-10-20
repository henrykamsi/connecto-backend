const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
const src = fs.readFileSync(file, 'utf8');

if (src.includes('[REAL-POST-DUMP]')) { console.log('Already added.'); process.exit(0); }

const before = '    res.json({ success: true, post: r.rows[0] });';
const after  = '    console.log("[REAL-POST-DUMP]", JSON.stringify({ keys: Object.keys(r.rows[0]), sample: r.rows[0] }));\n    res.json({ success: true, post: r.rows[0] });';

if (!src.includes(before)) {
  console.log('POST-DETAIL res.json anchor not found');
  const idx = src.indexOf('res.json({ success: true, post:');
  if (idx !== -1) console.log('Found at', idx, ':', src.slice(idx, idx + 100));
  process.exit(1);
}

const out = src.replace(before, after);

fs.writeFileSync(file + '.tmp.js', out);
try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
catch (e) { console.log('SYNTAX FAIL'); console.log((e.stderr||e.message).toString().slice(0,300)); fs.unlinkSync(file + '.tmp.js'); process.exit(1); }
fs.renameSync(file + '.tmp.js', file);

execSync('git add -A && git commit -m "log: real post-detail response keys" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED. Wait 2 min, tap a post, check Render logs for [REAL-POST-DUMP].');
