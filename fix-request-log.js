const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
const src = fs.readFileSync(file, 'utf8');

const before =
  'app.use(function logAllRequests(req, res, next) {\n' +
  '  if (req.method !== "GET") return next();\n' +
  '  if (req.path.startsWith("/control-api")) return next();\n' +
  '  console.log("[REQ]", req.method, req.path);\n' +
  '  next();\n' +
  '});';

const after =
  'app.use(function logAllRequests(req, res, next) {\n' +
  '  if (req.path.startsWith("/control-api")) return next();\n' +
  '  const start = Date.now();\n' +
  '  res.on("finish", function() {\n' +
  '    console.log("[REQ]", req.method, req.path, "->", res.statusCode, (Date.now()-start)+"ms");\n' +
  '  });\n' +
  '  next();\n' +
  '});';

if (!src.includes(before)) { console.log('anchor not found'); process.exit(1); }

const out = src.replace(before, after);

fs.writeFileSync(file + '.tmp.js', out);
try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
catch (e) { console.log('SYNTAX FAIL'); console.log((e.stderr||e.message).toString().slice(0,300)); fs.unlinkSync(file + '.tmp.js'); process.exit(1); }
fs.renameSync(file + '.tmp.js', file);

execSync('git add -A && git commit -m "log: full request log with status codes" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED. Wait 2 min, tap comment in app, check Render logs.');
