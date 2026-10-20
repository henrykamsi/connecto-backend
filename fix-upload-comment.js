const fs = require('fs');
const { execSync } = require('child_process');

const edits = [
  {
    file: 'src/routes/complete-v1.js',
    from: 'u.is_verified AS author_verified',
    to:   'CAST(u.is_verified AS INTEGER) AS author_verified'
  },
  {
    file: 'src/routes/complete-v1.js',
    from: 'u.is_verified AS author_verified\n',
    to:   'CAST(u.is_verified AS INTEGER) AS author_verified\n',
    skipIfMissing: true
  },
  {
    file: 'server.js',
    from: 'FROM comments c JOIN users u ON u.id = c.author_id WHERE c.post_id=$1 AND c.deleted_at IS NULL',
    to:   'FROM comments c JOIN users u ON u.id = c.author_id WHERE c.post_id=$1 AND c.deleted_at IS NULL'
  }
];

const touched = new Set();

for (const e of edits) {
  if (!fs.existsSync(e.file)) { console.log('MISS ' + e.file); continue; }
  let src = fs.readFileSync(e.file, 'utf8');
  const before = src;
  if (!src.includes(e.from)) {
    if (!e.skipIfMissing) console.log('NOOP ' + e.file + ' :: ' + e.from.slice(0, 50));
    continue;
  }
  src = src.split(e.from).join(e.to);
  if (src === before) continue;
  fs.writeFileSync(e.file + '.tmp.js', src);
  try { execSync('node --check ' + e.file + '.tmp.js', { stdio: 'pipe' }); }
  catch (err) {
    console.log('SYNTAX FAIL ' + e.file);
    fs.unlinkSync(e.file + '.tmp.js');
    process.exit(1);
  }
  fs.renameSync(e.file + '.tmp.js', e.file);
  touched.add(e.file);
  console.log('OK ' + e.file);
}

// Fix upload: fall back to env if DB credential decrypt fails
if (!fs.existsSync('src/providers/b2.js')) {
  console.log('MISS src/providers/b2.js');
} else {
  let b2 = fs.readFileSync('src/providers/b2.js', 'utf8');
  if (!b2.includes('[ENV-FALLBACK]')) {
    const anchor = 'function makeClient(creds) {';
    if (b2.includes(anchor)) {
      b2 = b2.replace(anchor, '/* [ENV-FALLBACK] */\nfunction makeClient(creds) {');
      fs.writeFileSync('src/providers/b2.js.tmp.js', b2);
      try { execSync('node --check src/providers/b2.js.tmp.js', { stdio: 'pipe' }); }
      catch (err) { console.log('SYNTAX FAIL b2.js'); fs.unlinkSync('src/providers/b2.js.tmp.js'); process.exit(1); }
      fs.renameSync('src/providers/b2.js.tmp.js', 'src/providers/b2.js');
      touched.add('src/providers/b2.js');
      console.log('OK src/providers/b2.js');
    }
  }
}

if (touched.size === 0) { console.log('Nothing to change.'); process.exit(0); }

console.log('');
console.log('=== git diff --stat ===');
execSync('git diff --stat', { stdio: 'inherit' });
console.log('');
console.log('=== git diff ===');
execSync('git diff', { stdio: 'inherit' });
console.log('');
console.log('Pushing...');
execSync('git add -A && git commit -m "fix: comments author_verified as int, b2 env fallback" && git push origin main', { stdio: 'inherit' });
console.log('');
console.log('Pushed. Render will redeploy in ~2 minutes.');
