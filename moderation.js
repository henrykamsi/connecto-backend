
const express = require("express");
const router = express.Router();
const { query, run } = require("./src/db");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const envLocal = require("./src/config/env");

router.post("/", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const text = String(req.body.body || "").trim();
    const mediaId = req.body.media_id;

    // 1. Run GPT Moderation
    let warningLabel = null;
    const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    
    if (keys.length > 0) {
      const input = [];
      if (text) input.push({ type: "text", text: text });
      
      if (mediaId) {
        try {
          const m = await query("SELECT storage_key, type FROM media WHERE id=$1 LIMIT 1", [mediaId]);
          if (m.rows.length && m.rows[0].storage_key && m.rows[0].storage_key.startsWith("http")) {
            const imgRes = await fetch(m.rows[0].storage_key);
            if (imgRes.ok) {
              const arrayBuffer = await imgRes.arrayBuffer();
              const base64Img = Buffer.from(arrayBuffer).toString("base64");
              const mime = imgRes.headers.get("content-type") || "image/jpeg";
              input.push({ type: "image_url", image_url: { url: "data:" + mime + ";base64," + base64Img } });
            }
          }
        } catch (e) { console.warn("[MOD-IMG-FAIL]", e.message); }
      }

      if (input.length > 0) {
        const payload = JSON.stringify({ model: "omni-moderation-latest", input: input });
        for (const key of keys) {
          try {
            const r = await fetch("https://api.openai.com/v1/moderations", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
              body: payload
            });
            if (r.ok) {
              const data = await r.json();
              const cats = data.results[0].categories || {};
              
let isHardBlocked = false;
              const scores = data.results[0].category_scores || {};
              if (cats["sexual"] || cats["sexual/minors"]) {
                if (scores["sexual"] > 0.99) {
                  isHardBlocked = true;
                  return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" });
                }
                warningLabel = "NUDITY CONTENT (18+)";
              }
              else if (cats["violence"] || cats["violence/graphic"]) warningLabel = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
              else if (cats["self-harm"]) warningLabel = "DO NOT TRY THIS";
              else if (cats["harassment"] || cats["hate"]) warningLabel = "INAPPROPRIATE CONTENT";
              break;
            }
          } catch (e) { }
        }
      }
    }

    // 2. Save the Post
    const postId = uuidv4();
    const visibility = req.body.visibility || "public";
    const commentsEnabled = req.body.commentsEnabled !== false ? 1 : 0;
    const shareEnabled = req.body.shareEnabled !== false ? 1 : 0;
    const isAiContent = req.body.is_ai_content ? 1 : 0;
    const warningStyle = warningLabel ? "danger" : null;

    await run(
      "INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, is_ai_content, warning_label, warning_label_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [postId, me, text || " ", visibility, commentsEnabled, shareEnabled, isAiContent, warningLabel, warningStyle]
    );

    // 3. Attach the media explicitly
    if (mediaId) {
      await run("UPDATE media SET post_id=$1, processing_status='ready', visibility='public' WHERE id=$2 AND owner_id=$3", [postId, mediaId, me]);
    }

    // 4. Fetch the created post to return to Android
    const r = await query("SELECT p.*, u.first_name, u.surname, u.username, u.profile_photo_media_id, (SELECT storage_key FROM media m WHERE m.post_id=p.id LIMIT 1) as media_url FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id=$1 LIMIT 1", [postId]);
    
    res.status(201).json({ success: true, post: r.rows[0] });
  } catch (err) {
    console.error("[MODERATION-POST-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
