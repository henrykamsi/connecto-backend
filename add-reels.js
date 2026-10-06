const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[REELS-ENDPOINT]")) {
  console.log("SKIP: reels already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';
if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [REELS-ENDPOINT] Paginated video feed, one video per user, newest first */
app.get("/api/v1/reels", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    try { jwt.verify(authHeader.slice(7), envLocal.jwt.secret); }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const limit = Math.min(Number(req.query.limit || 10), 30);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const r = await query(
      \`SELECT p.id, p.text, p.author_id, p.created_at, p.view_count,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              u.is_verified AS author_verified,
              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL LIMIT 1) AS media_url,
              'video' AS media_type,
              (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.deleted_at IS NULL
         AND u.account_status='active'
         AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL)
       ORDER BY p.created_at DESC
       LIMIT \$1 OFFSET \$2\`,
      [limit, offset]
    );

    res.json({ success: true, posts: r.rows, pagination: { limit, offset } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: reels endpoint added");
