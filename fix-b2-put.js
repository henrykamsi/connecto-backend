const fs = require('fs');
const { execSync } = require('child_process');

const file = 'src/providers/b2.js';
if (!fs.existsSync(file)) { console.log('MISS ' + file); process.exit(1); }

let src = fs.readFileSync(file, 'utf8');

if (src.includes('[B2-PUT-RELAX]')) {
  console.log('Already applied.');
  process.exit(0);
}

// Find the signedDownload function and add a new function for PUT signing.
// But the signing for POST media actually happens in server.js [PATCH-C], not here.
// So let's add the helper and let server.js use it.
// Actually the signB2Put function is in server.js [PATCH-C], not in b2.js.

// Better: patch server.js's signB2Put function.
const serverFile = 'server.js';
let srv = fs.readFileSync(serverFile, 'utf8');

const before =
  "async function signB2Put(cred, key, contentType) {\n" +
  "  const s3 = makeB2Client(cred);\n" +
  "  const cmd = new PutObjectCommand({\n" +
  "    Bucket: cred.bucket,\n" +
  "    Key: key,\n" +
  "    ContentType: contentType\n" +
  "  });\n" +
  "  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });\n" +
  "  return url;\n" +
  "}";

const after =
  "async function signB2Put(cred, key, contentType) {\n" +
  "  /* [B2-PUT-RELAX] Don't bind Content-Type or Content-Length into the signature.\n" +
  "     This lets the client send any bytes without a SignatureDoesNotMatch error. */\n" +
  "  const s3 = makeB2Client(cred);\n" +
  "  const cmd = new PutObjectCommand({\n" +
  "    Bucket: cred.bucket,\n" +
  "    Key: key\n" +
  "  });\n" +
  "  const url = await getSignedUrl(s3, cmd, { expiresIn: 900, signableHeaders: new Set() });\n" +
  "  return url;\n" +
  "}";

if (!srv.includes(before)) {
  console.log('signB2Put anchor not found — showing surrounding code:');
  const idx = srv.indexOf('async function signB2Put');
  if (idx !== -1) console.log(srv.slice(idx, idx + 500));
  process.exit(1);
}

srv = srv.replace(before, after);

fs.writeFileSync(serverFile + '.tmp.js', srv);
try { execSync('node --check ' + serverFile + '.tmp.js', { stdio: 'pipe' }); }
catch (e) {
  console.log('SYNTAX FAIL');
  console.log((e.stderr ? e.stderr.toString() : e.message).slice(0, 300));
  fs.unlinkSync(serverFile + '.tmp.js');
  process.exit(1);
}
fs.renameSync(serverFile + '.tmp.js', serverFile);

console.log('OK server.js updated');
console.log('');
execSync('git diff server.js', { stdio: 'inherit' });
console.log('');
execSync('git add -A && git commit -m "fix: relax B2 PUT signature to accept any content-type/length" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED. Wait 2 min then test upload in the app.');
