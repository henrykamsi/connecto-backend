const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
const src = fs.readFileSync(file, 'utf8');

if (src.includes('[DIAG-POST]')) { console.log('Already added.'); process.exit(0); }

const anchor = 'app.use((err, req, res, next) => {';
if (!src.includes(anchor)) { console.log('anchor not found'); process.exit(1); }

const block =
"/* [DIAG-POST] */\n" +
"app.get('/api/v1/diag/post/:id', async (req, res) => {\n" +
"  try {\n" +
"    const r = await query(\"SELECT p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.like_count_visible, p.share_enabled, p.original_post_id, p.created_at, p.updated_at, p.deleted_at, p.is_ai_content, u.first_name, u.surname, u.username, u.profile_photo_media_id, (SELECT COUNT(*) FROM reactions WHERE post_id=p.id) AS reaction_count, (SELECT COUNT(*) FROM comments WHERE post_id=p.id AND deleted_at IS NULL) AS comment_count FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id=$1 LIMIT 1\", [req.params.id]);\n" +
"    if (!r.rows.length) return res.status(404).json({ success: false, error: 'NOT_FOUND' });\n" +
"    const row = r.rows[0];\n" +
"    const types = {};\n" +
"    for (const k of Object.keys(row)) types[k] = row[k] === null ? 'null' : typeof row[k];\n" +
"    res.json({ success: true, row, types });\n" +
"  } catch (e) { res.status(500).json({ success: false, error: e.message, stack: e.stack }); }\n" +
"});\n" +
"/* [/DIAG-POST] */\n\n";

fs.writeFileSync(file + '.tmp.js', src.replace(anchor, block + anchor));
try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
catch (e) { console.log('SYNTAX FAIL'); console.log((e.stderr||e.message).toString().slice(0,300)); fs.unlinkSync(file + '.tmp.js'); process.exit(1); }
fs.renameSync(file + '.tmp.js', file);

execSync('git add -A && git commit -m "diag: post response type dump" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED.');
