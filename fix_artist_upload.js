const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

if (!modSrc.includes('router.post("/artist/save-song"')) {
  const artistRoute = `
// SAVE SONG
router.post("/artist/save-song", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { 
        const jwt = require("jsonwebtoken");
        const envLocal = require("./src/config/env");
        me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; 
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const { title, artist_name, audio_url, cover_art_url } = req.body;
    if (!title || !audio_url) return res.status(400).json({ success: false, error: "MISSING_FIELDS" });

    const { v4: uuidv4 } = require("uuid");
    const soundId = uuidv4();
    
    await run(
      "INSERT INTO sounds (id, creator_user_id, name, audio_url, cover_art_url) VALUES ($1,$2,$3,$4,$5)",
      [soundId, me, title, audio_url, cover_art_url || null]
    );

    res.json({ success: true, sound_id: soundId, message: "Song uploaded successfully" });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET MY SONGS
router.get("/artist/my-songs", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { 
        const jwt = require("jsonwebtoken");
        const envLocal = require("./src/config/env");
        me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; 
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const songs = await query("SELECT * FROM sounds WHERE creator_user_id=$1 ORDER BY created_at DESC", [me]);
    res.json({ success: true, songs: songs.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
`;
  modSrc = modSrc.replace("module.exports = router;", artistRoute + "\nmodule.exports = router;");
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Added save-song and my-songs routes to moderation.js");
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
