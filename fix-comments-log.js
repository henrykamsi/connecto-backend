const fs = require('fs');
const { execSync } = require('child_process');

const file = 'src/routes/complete-v1.js';
const src = fs.readFileSync(file, 'utf8');

if (src.includes('[COMMENTS-LOG]')) { console.log('Already added.'); process.exit(0); }

// Find the comments handler's catch block
const before =
  "router.get('/posts/:id/comments',auth,async(req,res)=>{\n" +
  "  try {\n" +
  "    const r = await query(";

const after =
  "router.get('/posts/:id/comments',auth,async(req,res)=>{\n" +
  "  try {\n" +
  "    console.log('[COMMENTS-LOG] fetching for post', req.params.id);\n" +
  "    const r = await query(";

if (!src.includes(before)) {
  console.log('Comments handler anchor not found.');
  const idx = src.indexOf("router.get('/posts/:id/comments'");
  if (idx !== -1) console.log(src.slice(idx, idx + 400));
  process.exit(1);
}

let out = src.replace(before, after);

// Also add error logging to the catch
const catchBefore =
  "  } catch (e) {\n" +
  "    res.status(500).json({ success: false, error: e.message });\n" +
  "  }\n" +
  "});";

const catchAfter =
  "  } catch (e) {\n" +
  "    console.error('[COMMENTS-LOG] FAILED:', e.message, e.stack);\n" +
  "    res.status(500).json({ success: false, error: e.message });\n" +
  "  }\n" +
  "});";

out = out.replace(catchBefore, catchAfter);

fs.writeFileSync(file + '.tmp.js', out);
try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
catch (e) { console.log('SYNTAX FAIL'); console.log((e.stderr||e.message).toString().slice(0,300)); fs.unlinkSync(file + '.tmp.js'); process.exit(1); }
fs.renameSync(file + '.tmp.js', file);

execSync('git add -A && git commit -m "log: comments handler error trace" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED. Wait 2 min, then tap a comment in the app, then check Render logs.');
