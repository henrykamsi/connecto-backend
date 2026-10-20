const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
const src = fs.readFileSync(file, 'utf8');

const patches = [
  ['is_verified: Number(u.is_verified) === 1,',        'is_verified: Number(u.is_verified) === 1 ? 1 : 0,'],
  ['is_owner: Number(u.is_owner) === 1,',              'is_owner: Number(u.is_owner) === 1 ? 1 : 0,'],
  ['author_verified: Number(row.author_verified) === 1,', 'author_verified: Number(row.author_verified) === 1 ? 1 : 0,'],
];

let out = src;
let changed = 0;
for (const [from, to] of patches) {
  const count = out.split(from).length - 1;
  if (count === 0) { console.log('  SKIP (not found): ' + from); continue; }
  out = out.split(from).join(to);
  changed += count;
  console.log('  PATCHED (' + count + 'x): ' + from.slice(0, 40) + '...');
}

if (changed === 0) { console.log('Nothing to patch.'); process.exit(0); }

fs.writeFileSync(file + '.tmp.js', out);
try {
  execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' });
  console.log('  ✓ syntax OK');
} catch (e) {
  console.log('  ✗ syntax FAIL');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  fs.unlinkSync(file + '.tmp.js');
  process.exit(1);
}

fs.renameSync(file + '.tmp.js', file);
console.log('  ✓ server.js updated (' + changed + ' line(s))');
console.log('');
console.log('=== git diff (server.js) ===');
execSync('git diff server.js', { stdio: 'inherit' });
console.log('');
console.log('=== NOT PUSHED ===');
console.log('To push:');
console.log('  git add server.js && git commit -m "fix: return is_verified/is_owner/author_verified as int not bool" && git push origin main');
console.log('');
console.log('To revert:');
console.log('  git restore server.js');
