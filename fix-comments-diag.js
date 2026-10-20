const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
const src = fs.readFileSync(file, 'utf8');

if (src.includes('[DIAG-COMMENTS]')) { console.log('Already added.'); process.exit(0); }

const anchor = 'app.use((err, req, res, next) => {';
if (!src.includes(anchor)) { console.log('anchor not found'); process.exit(1); }

const block =
"/* [DIAG-COMMENTS] */\n" +
"app.get('/api/v1/diag/comments/:id', async (req, res) => {\n" +
"  try {\n" +
"    const r = await query(\n" +
"      \"SELECT c.id, c.body, c.author_id, c.parent_comment_id, c.created_at, u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified AS author_verified FROM comments c JOIN users u ON u.id = c.author_id WHERE c.post_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at ASC LIMIT 200\",\n" +
"      [req.params.id]\n" +
"    );\n" +
"    const sample = r.rows[0] || null;\n" +
"    const types = sample ? Object.fromEntries(Object.keys(sample).map(k => [k, sample[k] === null ? 'null' : typeof sample[k]])) : {};\n" +
"    res.json({ success: true, count: r.rows.length, sample, types });\n" +
"  } catch (e) { res.status(500).json({ success: false, error: e.message, stack: e.stack }); }\n" +
"});\n" +
"/* [/DIAG-COMMENTS] */\n\n";

fs.writeFileSync(file + '.tmp.js', src.replace(anchor, block + anchor));
try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
catch (e) { console.log('SYNTAX FAIL'); console.log((e.stderr||e.message).toString().slice(0,300)); fs.unlinkSync(file + '.tmp.js'); process.exit(1); }
fs.renameSync(file + '.tmp.js', file);

execSync('git add -A && git commit -m "diag: dump comments response shape" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED.');
