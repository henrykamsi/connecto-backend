const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "server.js");
if (!fs.existsSync(serverPath)) {
  console.error("ERROR: server.js not found.");
  process.exit(1);
}

let src = fs.readFileSync(serverPath, "utf8");

if (src.includes("[MASTER-BACKEND-FIX]")) {
  console.log("SKIP: Backend already patched.");
  process.exit(0);
}

// 1. ADD SCHEMA UPDATES
const schemaBlock = `
/* [MASTER-BACKEND-FIX] */
(async () => {
  try {
    const { run } = require("./src/db");
    try { await run("ALTER TABLE posts ADD COLUMN is_ai_content INTEGER DEFAULT 0"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN privacy TEXT DEFAULT 'public'"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN boost_boost INTEGER DEFAULT 0"); } catch (e) {}
    try { await run("ALTER TABLE users ADD COLUMN is_artist INTEGER DEFAULT 0"); } catch (e) {}
    
    await run("CREATE TABLE IF NOT EXISTS sounds (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, artist_name TEXT, audio_url TEXT, cover_art_url TEXT, used_in_videos INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE TABLE IF NOT EXISTS sound_favorites (user_id TEXT, sound_id TEXT, PRIMARY KEY(user_id, sound_id))");
    console.log("[MASTER-BACKEND-FIX] Schema ready");
  } catch (e) {
    console.error("[MASTER-BACKEND-FIX] Schema error:", e.message);
  }
})();
`;

const dbImport = 'const { query } = require("./src/db");';
if (src.includes(dbImport)) {
    src = src.replace(dbImport, dbImport + "\n" + schemaBlock);
}

// 2. ADD UNIFIED SEARCH (Handles brackets, users, videos, music)
const searchBlock = `
/* [MASTER-BACKEND-FIX] Unified Search */
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
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
    
    let users = [];
    let videos = [];
    let music = [];
    const db = require("./src/db");

    // Users
    if ((mode === "all" || mode === "user") && words.length > 0) {
      const like = "%" + words[0] + "%";
      const r = await db.query(
        "SELECT id, first_name, surname, username, bio, category, country, profile_photo_media_id, is_verified, is_artist, is_owner FROM users WHERE account_status='active' AND deleted_at IS NULL AND (lower(username) LIKE $1 OR lower(first_name) LIKE $1 OR lower(surname) LIKE $1) ORDER BY is_verified DESC, created_at DESC LIMIT $2",
        [like, limit]
      );
      users = r.rows;
    }

    // Videos
    if ((mode === "all" || mode === "video") && words.length > 0) {
      const like = "%" + words[0] + "%";
      const r = await db.query(
        "SELECT p.id, p.author_id, p.text, p.created_at, u.first_name, u.surname, u.username, u.is_verified as author_verified, (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' LIMIT 1) AS media_url FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND lower(p.text) LIKE $1 LIMIT $2",
        [like, limit]
      );
      // Sign B2 URLs
      const b2 = require("./src/providers/b2");
      videos = await Promise.all(r.rows.map(async row => {
        let mediaUrl = row.media_url;
        if (mediaUrl && String(mediaUrl).indexOf("http") !== 0) {
            try { mediaUrl = await b2.signedDownload(mediaUrl, 3600); } catch(e) {}
        }
        return { ...row, media_url: mediaUrl, media_type: "video", reaction_count: 0, comment_count: 0, view_count: 0 };
      }));
    }

    // Music
    if ((mode === "all" || mode === "music") && words.length > 0) {
      const like = "%" + words[0] + "%";
      const r = await db.query(
        "SELECT * FROM sounds WHERE lower(title) LIKE $1 OR lower(artist_name) LIKE $1 LIMIT $2",
        [like, limit]
      );
      music = r.rows;
    }

    res.json({ success: true, mode, users, videos, music });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
`;

const errorHandler = 'app.use((err, req, res, next) => {';
if (src.includes(errorHandler)) {
    src = src.replace(errorHandler, searchBlock + "\n" + errorHandler);
}

// 3. FIX LINK PREVIEW API
const linkPreviewBlock = `
/* [MASTER-BACKEND-FIX] Link Preview Route */
app.post("/api/v1/link-preview", async (req, res) => {
  try {
    const url = String(req.body.url || "").trim();
    if (!url) return res.status(400).json({ success: false, error: "URL_REQUIRED" });
    
    // Basic fetch to get OG tags
    const resp = await fetch(url, { headers: { "User-Agent": "ConnectoBot/1.0" } });
    const html = await resp.text();
    
    const getMeta = (prop) => {
      const match = html.match(new RegExp('<meta[^>]+property=["\\']' + prop + '["\\'][^>]+content=["\\']([^"\\']*)["\\']', 'i')) ||
                    html.match(new RegExp('<meta[^>]+name=["\\']' + prop + '["\\'][^>]+content=["\\']([^"\\']*)["\\']', 'i'));
      return match ? match[1] : null;
    };

    const titleMatch = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);

    res.json({
      success: true,
      preview: {
        url: url,
        title: getMeta("og:title") || (titleMatch ? titleMatch[1] : url),
        description: getMeta("og:description") || getMeta("description"),
        image_url: getMeta("og:image"),
        favicon_url: "https://www.google.com/s2/favicons?domain=" + url + "&sz=64",
        site_name: getMeta("og:site_name") || new URL(url).hostname
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
`;

if (src.includes(errorHandler)) {
    src = src.replace(errorHandler, linkPreviewBlock + "\n" + errorHandler);
}

// 4. ADD ARTIST HUB ENDPOINTS
const artistBlock = `
/* [MASTER-BACKEND-FIX] Artist & Sounds */
app.post("/api/v1/artist/apply", async (req, res) => {
  try {
    const db = require("./src/db");
    await db.query("UPDATE users SET is_artist=1 WHERE id=$1", [req.user?.id || req.body.user_id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/sounds/search", async (req, res) => {
    try {
        const db = require("./src/db");
        const q = String(req.query.q || "");
        const r = await db.query("SELECT * FROM sounds WHERE lower(title) LIKE lower($1) OR lower(artist_name) LIKE lower($1) LIMIT 50", ["%" + q + "%"]);
        res.json({ success: true, sounds: r.rows });
    } catch (e) {
        res.json({ success: true, sounds: [] });
    }
});
`;

if (src.includes(errorHandler)) {
    src = src.replace(errorHandler, artistBlock + "\n" + errorHandler);
}

fs.writeFileSync(serverPath, src);
console.log("OK: [MASTER-BACKEND-FIX] applied to server.js");
