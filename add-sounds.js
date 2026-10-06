const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[SOUNDS-ENDPOINTS]")) {
  console.log("SKIP: sounds already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';
if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [SOUNDS-ENDPOINTS] Full music system */

(async () => {
  try {
    const { run } = require("./src/db");

    await run(\`CREATE TABLE IF NOT EXISTS sounds (
      id TEXT PRIMARY KEY,
      creator_user_id TEXT,
      original_post_id TEXT,
      name TEXT,
      audio_url TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )\`);

    await run(\`CREATE TABLE IF NOT EXISTS post_sounds (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      sound_id TEXT NOT NULL,
      used_by_user_id TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id)
    )\`);

    await run("CREATE INDEX IF NOT EXISTS idx_post_sounds_sound ON post_sounds(sound_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_post_sounds_post ON post_sounds(post_id)");
    console.log("[SOUNDS] schema ready");
  } catch (e) {
    console.error("[SOUNDS] schema:", e.message);
  }
})();

function soundAuth() {
  return async function (req, res, next) {
    try {
      const jwt = require("jsonwebtoken");
      const envLocal = require("./src/config/env");
      const { query } = require("./src/db");
      const h = req.headers.authorization || "";
      if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
      const p = jwt.verify(h.slice(7), envLocal.jwt.secret);
      const u = await query("SELECT id, email FROM users WHERE id=$1 LIMIT 1", [p.sub]);
      if (!u.rows.length) return res.status(401).json({ success: false, error: "USER_NOT_FOUND" });
      req.user = { id: u.rows[0].id, email: u.rows[0].email };
      next();
    } catch (e) {
      res.status(401).json({ success: false, error: "INVALID_SESSION" });
    }
  };
}

/* Get sound details + list of videos using it */
app.get("/api/v1/sounds/:id", soundAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const sound = await query(
      \`SELECT s.*, u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified
       FROM sounds s
       LEFT JOIN users u ON u.id = s.creator_user_id
       WHERE s.id=$1 LIMIT 1\`,
      [req.params.id]
    );
    if (!sound.rows.length) return res.status(404).json({ success: false, error: "SOUND_NOT_FOUND" });

    const posts = await query(
      \`SELECT p.id, p.text, p.author_id, p.created_at, p.view_count,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              u.is_verified AS author_verified,
              ps.used_at,
              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key,
              (SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type
       FROM post_sounds ps
       JOIN posts p ON p.id = ps.post_id
       JOIN users u ON u.id = p.author_id
       WHERE ps.sound_id=$1 AND p.deleted_at IS NULL
       ORDER BY ps.used_at ASC
       LIMIT 100\`,
      [req.params.id]
    );

    const usersList = await query(
      "SELECT DISTINCT used_by_user_id FROM post_sounds WHERE sound_id=$1",
      [req.params.id]
    );

    res.json({
      success: true,
      sound: sound.rows[0],
      videos: posts.rows,
      user_count: usersList.rows.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Create a new sound from a video's audio (auto — first uploader) */
app.post("/api/v1/sounds", soundAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const id = uuidv4();
    await run(
      "INSERT INTO sounds (id, creator_user_id, original_post_id, name, audio_url, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        id,
        req.user.id,
        req.body.originalPostId || null,
        req.body.name || "Original sound",
        req.body.audioUrl || null,
        Number(req.body.durationMs) || null
      ]
    );
    res.json({ success: true, soundId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Link a post to a sound + compute badge */
app.post("/api/v1/sounds/:id/use", soundAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const soundId = req.params.id;
    const postId = String(req.body.postId || "").trim();
    if (!postId) return res.status(400).json({ success: false, error: "POST_ID_REQUIRED" });

    const existing = await query("SELECT id FROM post_sounds WHERE post_id=$1 LIMIT 1", [postId]);
    if (existing.rows.length) return res.json({ success: true, alreadyLinked: true });

    await run(
      "INSERT INTO post_sounds (id, post_id, sound_id, used_by_user_id) VALUES ($1,$2,$3,$4)",
      [uuidv4(), postId, soundId, req.user.id]
    );

    const count = await query(
      "SELECT COUNT(DISTINCT used_by_user_id) AS c FROM post_sounds WHERE sound_id=$1",
      [soundId]
    );
    const n = Number(count.rows[0].c || 1);

    let badge = null;
    if (n === 1) badge = "original";
    else if (n === 2) badge = "effect";
    else if (n === 3) badge = "cloner";

    res.json({ success: true, badge: badge, userCount: n });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Get the sound attached to a post (for the spinning disc badge) */
app.get("/api/v1/posts/:id/sound", soundAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const r = await query(
      \`SELECT ps.sound_id, ps.used_at,
              s.name, s.audio_url, s.duration_ms, s.creator_user_id,
              u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified
       FROM post_sounds ps
       JOIN sounds s ON s.id = ps.sound_id
       LEFT JOIN users u ON u.id = s.creator_user_id
       WHERE ps.post_id=$1 LIMIT 1\`,
      [req.params.id]
    );
    if (!r.rows.length) return res.json({ success: true, sound: null });
    res.json({ success: true, sound: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: sounds endpoints + schema added");
