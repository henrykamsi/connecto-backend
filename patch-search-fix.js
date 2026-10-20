const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "server.js");
if (!fs.existsSync(serverPath)) {
  console.error("ERROR: server.js not found.");
  process.exit(1);
}

let src = fs.readFileSync(serverPath, "utf8");

if (src.includes("[SEARCH-FIX-SQLITE]")) {
  console.log("SKIP: Search already fixed.");
  process.exit(0);
}

// 1. Remove the old broken search block
const oldSearchStart = src.indexOf('/* [MASTER-BACKEND-FIX] Unified Search */');
if (oldSearchStart !== -1) {
  // Find the end of the broken app.get("/api/v1/search")
  const oldSearchEnd = src.indexOf('});', src.indexOf('res.json({ success: true, mode, users, videos, music });', oldSearchStart)) + 3;
  src = src.slice(0, oldSearchStart) + src.slice(oldSearchEnd);
}

// 2. Add the new SQLite-compatible search
const newSearch = `
/* [SEARCH-FIX-SQLITE] Unified Search (Turso Compatible) */
function parseSearchQuery(raw) {
  const original = String(raw || "").trim();
  const m = original.match(/^([\\s\\S]*?)\\[([a-zA-Z]+)\\]\\s*$/);
  if (!m) return { query: original, mode: "all" };
  const q = String(m[1] || "").trim();
  const tag = String(m[2] || "").toLowerCase();
  let mode = "all";
  if (tag === "video" || tag === "videos") mode = "video";
  else if (tag === "user" || tag === "users" || tag === "people") mode = "user";
  else if (tag === "music") mode = "music";
  return { query: q, mode };
}

app.get("/api/v1/search", async (req, res) => {
  try {
    const { query, mode } = parseSearchQuery(req.query.q || "");
    const words = query.toLowerCase().split(/\\s+/).filter(w => w.length > 0);
    const limit = 20;
    
    let users = [];
    let videos = [];
    let music = [];
    const db = require("./src/db");

    if (words.length > 0) {
      const like = "%" + words[0] + "%";

      // 1. Users (using correct $1, $2 syntax for Turso serverless)
      if (mode === "all" || mode === "user") {
        const r = await db.query(
          "SELECT id, first_name, surname, username, bio, category, country, profile_photo_media_id, is_verified, is_artist, is_owner FROM users WHERE account_status='active' AND deleted_at IS NULL AND (lower(username) LIKE $1 OR lower(first_name) LIKE $1 OR lower(surname) LIKE $1) ORDER BY is_verified DESC, created_at DESC LIMIT $2",
          [like, limit]
        );
        users = r.rows;
      }

      // 2. Videos
      if (mode === "all" || mode === "video") {
        const r = await db.query(
          "SELECT p.id, p.author_id, p.text, p.created_at, u.first_name, u.surname, u.username, u.is_verified as author_verified, (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' LIMIT 1) AS media_url FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND lower(p.text) LIKE $1 LIMIT $2",
          [like, limit]
        );
        const b2 = require("./src/providers/b2");
        videos = await Promise.all(r.rows.map(async row => {
          let mediaUrl = row.media_url;
          if (mediaUrl && String(mediaUrl).indexOf("http") !== 0) {
              try { mediaUrl = await b2.signedDownload(mediaUrl, 3600); } catch(e) {}
          }
          return { ...row, media_url: mediaUrl, media_type: "video", reaction_count: 0, comment_count: 0, view_count: 0 };
        }));
      }

      // 3. Music
      if (mode === "all" || mode === "music") {
        const r = await db.query(
          "SELECT * FROM sounds WHERE lower(title) LIKE $1 OR lower(artist_name) LIKE $1 LIMIT $2",
          [like, limit]
        );
        music = r.rows;
      }
    }

    res.json({ success: true, mode, users, videos, music });
  } catch (err) {
    console.error("[SEARCH-ERROR]", err.message);
    res.json({ success: true, mode: "all", users: [], videos: [], music: [] });
  }
});
`;

// Insert the new search block before the error handler
const errorHandler = 'app.use((err, req, res, next) => {';
if (src.includes(errorHandler)) {
    src = src.replace(errorHandler, newSearch + "\n" + errorHandler);
} else {
    console.error("ERROR: Could not find error handler to inject search.");
    process.exit(1);
}

fs.writeFileSync(serverPath, src);
console.log("OK: [SEARCH-FIX-SQLITE] applied to server.js");
