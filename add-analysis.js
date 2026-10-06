const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[ANALYSIS-ENDPOINT]")) {
  console.log("SKIP: analysis already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';
if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [ANALYSIS-ENDPOINT] Returns engagement numbers for a post */
app.get("/api/v1/posts/:id/analysis", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const postId = req.params.id;
    const p = await query("SELECT * FROM posts WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL LIMIT 1", [postId, userId]);
    if (!p.rows.length) return res.status(404).json({ success: false, error: "POST_NOT_FOUND_OR_NOT_OWNER" });

    const likes = await query("SELECT COUNT(*) AS c FROM reactions WHERE post_id=$1", [postId]);
    const comments = await query("SELECT COUNT(*) AS c FROM comments WHERE post_id=$1 AND deleted_at IS NULL", [postId]);
    const shares = await query("SELECT COUNT(*) AS c FROM shares WHERE post_id=$1", [postId]).catch(() => ({ rows: [{ c: 0 }] }));
    const views = await query("SELECT COALESCE(view_count, 0) AS c FROM posts WHERE id=$1", [postId]);

    res.json({
      success: true,
      post_id: postId,
      likes: Number(likes.rows[0].c || 0),
      comments: Number(comments.rows[0].c || 0),
      shares: Number(shares.rows[0].c || 0),
      views: Number(views.rows[0].c || 0)
    });
  } catch (err) {
    console.error("[ANALYSIS]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: analysis endpoint added");
