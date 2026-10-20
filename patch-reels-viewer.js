const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

if (s.includes('[REELS-VIEWER-FIX]')) {
  console.log('already patched — skipping');
  process.exit(0);
}

// --- 1) Capture userId from JWT payload ---
const oldAuth =
  '    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });\n' +
  '    try { jwt.verify(authHeader.slice(7), envLocal.jwt.secret); }\n' +
  '    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }';

const newAuth =
  '    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });\n' +
  '    let userId = null;\n' +
  '    try { const _p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = _p.sub; }\n' +
  '    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }';

// --- 2) Add viewer_reacted_int subquery to SQL ---
const oldSql =
  "              (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count,\n" +
  "              (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count\n" +
  "       FROM posts p";

const newSql =
  "              (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count,\n" +
  "              (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count,\n" +
  "              (SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=$3 LIMIT 1) AS viewer_reacted_int\n" +
  "       FROM posts p";

// --- 3) Pass userId as third arg ---
const oldArgs = "      [limit, offset]\n    );";
const newArgs = "      [limit, offset, userId]\n    );";

// --- 4) Map viewer_reacted_int -> viewer_has_reacted in response ---
const oldReturn = "      return { ...row, media_url: mediaUrl };\n    }));";
const newReturn =
  "      const { viewer_reacted_int, ...rest } = row;\n" +
  "      return { ...rest, media_url: mediaUrl, viewer_has_reacted: Number(viewer_reacted_int) === 1 };\n" +
  "    }));";

let n = 0;
if (s.includes(oldAuth))   { s = s.replace(oldAuth,   newAuth);   n++; }
if (s.includes(oldSql))    { s = s.replace(oldSql,    newSql);    n++; }
if (s.includes(oldArgs))   { s = s.replace(oldArgs,   newArgs);   n++; }
if (s.includes(oldReturn)) { s = s.replace(oldReturn, newReturn); n++; }

if (n !== 4) {
  console.error("ERROR: matched " + n + "/4 fragments. Aborting — file unchanged.");
  process.exit(1);
}

// --- 5) Add /api/v1/posts/:id/counts endpoint ---
const anchor = 'app.use("/api/v1", v1);';
if (!s.includes(anchor)) {
  console.error("ERROR: mount anchor not found");
  process.exit(1);
}

const block =
'\n/* [REELS-VIEWER-FIX] Lightweight per-post counts refresh */\n' +
'app.get("/api/v1/posts/:id/counts", async (req, res) => {\n' +
'  try {\n' +
'    const { query } = require("./src/db");\n' +
'    const jwt = require("jsonwebtoken");\n' +
'    const envLocal = require("./src/config/env");\n' +
'\n' +
'    const authHeader = req.headers.authorization || "";\n' +
'    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });\n' +
'    let userId = null;\n' +
'    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }\n' +
'    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }\n' +
'\n' +
'    const postId = req.params.id;\n' +
'\n' +
'    const r = await query(\n' +
'      "SELECT " +\n' +
'      "(SELECT COUNT(*) FROM reactions WHERE post_id=$1) AS reaction_count, " +\n' +
'      "(SELECT COUNT(*) FROM comments WHERE post_id=$1 AND deleted_at IS NULL) AS comment_count, " +\n' +
'      "COALESCE(view_count, 0) AS view_count, " +\n' +
'      "(SELECT 1 FROM reactions WHERE post_id=$1 AND user_id=$2 LIMIT 1) AS viewer_reacted_int " +\n' +
'      "FROM posts WHERE id=$1 AND deleted_at IS NULL LIMIT 1",\n' +
'      [postId, userId]\n' +
'    );\n' +
'\n' +
'    if (!r.rows.length) return res.status(404).json({ success: false, error: "POST_NOT_FOUND" });\n' +
'\n' +
'    const row = r.rows[0];\n' +
'    res.json({\n' +
'      success: true,\n' +
'      post_id: postId,\n' +
'      reaction_count: Number(row.reaction_count || 0),\n' +
'      comment_count: Number(row.comment_count || 0),\n' +
'      view_count: Number(row.view_count || 0),\n' +
'      viewer_has_reacted: Number(row.viewer_reacted_int) === 1\n' +
'    });\n' +
'  } catch (err) {\n' +
'    console.error("[POST-COUNTS]", err);\n' +
'    res.status(500).json({ success: false, error: err.message });\n' +
'  }\n' +
'});\n\n';

s = s.replace(anchor, block + anchor);

fs.writeFileSync('server.js', s);
console.log('OK: reels viewer fix + /posts/:id/counts added');
