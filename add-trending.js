const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[TRENDING-ENDPOINT]")) {
  console.log("SKIP: trending already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';

if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [TRENDING-ENDPOINT] Top videos by views, top videos by likes, top celebrities */
app.get("/api/v1/search/trending", async (req, res) => {
  try {
    const { query } = require("./src/db");

    const topViewed = await query(
      \`SELECT p.id, p.text, p.author_id, p.created_at, p.view_count,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              u.is_verified AS author_verified,
              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL LIMIT 1) AS media_url
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL)
       ORDER BY COALESCE(p.view_count, 0) DESC
       LIMIT 5\`
    );

    const topLiked = await query(
      \`SELECT p.id, p.text, p.author_id, p.created_at,
              COALESCE((SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id), 0) AS reaction_count,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              u.is_verified AS author_verified,
              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL LIMIT 1) AS media_url
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL)
       ORDER BY reaction_count DESC
       LIMIT 5\`
    );

    const topCelebs = await query(
      \`SELECT id, first_name, surname, username, profile_photo_media_id,
              COALESCE(display_followers, 0) AS followers,
              is_verified, is_owner
       FROM users
       WHERE is_verified=1 AND account_status='active'
       ORDER BY COALESCE(display_followers, 0) DESC, created_at ASC
       LIMIT 10\`
    );

    res.json({
      success: true,
      top_viewed_videos: topViewed.rows,
      top_liked_videos: topLiked.rows,
      top_celebrities: topCelebs.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* [TRENDING-ENDPOINT] Record a view — dedup per user */
app.post("/api/v1/posts/:id/view", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const { v4: uuidv4 } = require("uuid");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const postId = req.params.id;

    const seen = await query(
      "SELECT id FROM post_views WHERE post_id=$1 AND user_id=$2 LIMIT 1",
      [postId, userId]
    );

    if (seen.rows.length) {
      return res.json({ success: true, counted: false });
    }

    try {
      await run(
        "INSERT INTO post_views (id, post_id, user_id) VALUES ($1,$2,$3)",
        [uuidv4(), postId, userId]
      );
      await run(
        "UPDATE posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id=$1",
        [postId]
      );
      res.json({ success: true, counted: true });
    } catch (e) {
      res.json({ success: true, counted: false });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* [TRENDING-ENDPOINT] Create post_views table if missing */
(async () => {
  try {
    const { run } = require("./src/db");
    await run(\`CREATE TABLE IF NOT EXISTS post_views (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    )\`);
    await run("CREATE INDEX IF NOT EXISTS idx_post_views_post ON post_views(post_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_post_views_user ON post_views(user_id)");
  } catch (e) {
    console.error("[TRENDING] post_views schema:", e.message);
  }
})();

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: trending + view-count endpoints added");
