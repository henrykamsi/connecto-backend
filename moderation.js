
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

    if (!text && !mediaId) return res.status(400).json({ success: false, error: "POST_CONTENT_REQUIRED" });

    // 1. Run GPT Moderation
    let warningLabel = null;
    const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    
    if (keys.length > 0) {
      const input = [];
      if (text) input.push({ type: "text", text: text });
      
      // If media_id is provided, fetch the URL from DB
      if (mediaId) {
        try {
          const m = await query("SELECT storage_key, type FROM media WHERE id=$1 LIMIT 1", [mediaId]);
          if (m.rows.length && m.rows[0].storage_key && m.rows[0].storage_key.startsWith("http")) {
            const mediaUrl = m.rows[0].storage_key;
            console.log("[MOD] Downloading media for GPT:", mediaUrl.substring(0, 50) + "...");
            
            const imgRes = await fetch(mediaUrl);
            if (imgRes.ok) {
              const arrayBuffer = await imgRes.arrayBuffer();
              const base64Img = Buffer.from(arrayBuffer).toString("base64");
              const mime = imgRes.headers.get("content-type") || "image/jpeg";
              input.push({ type: "image_url", image_url: { url: "data:" + mime + ";base64," + base64Img } });
              console.log("[MOD] Media converted to base64, size:", base64Img.length);
            }
          }
        } catch (e) { console.warn("[MOD-IMG-FETCH-FAIL]", e.message); }
      }

      if (input.length > 0) {
        const payload = JSON.stringify({ model: "omni-moderation-latest", input: input });
        console.log("[MOD] Sending to OpenAI...");
        
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
              console.log("[MOD] OpenAI categories:", JSON.stringify(cats));
              
              // 2. Map categories to labels
              let triggered = [];
              if (cats["sexual"] || cats["sexual/minors"]) triggered.push("NUDITY CONTENT (18+)");
              if (cats["violence"] || cats["violence/graphic"]) triggered.push("OBJECTS IN THIS VIDEO MIGHT BE HARMFUL");
              if (cats["self-harm"]) triggered.push("DO NOT TRY THIS");
              if (cats["harassment"] || cats["hate"]) triggered.push("INAPPROPRIATE CONTENT");
              
              // If more than one, use the generic label
              if (triggered.length > 1) warningLabel = "INAPPROPRIATE CONTENT";
              else if (triggered.length === 1) warningLabel = triggered[0];
              
              console.log("[MOD] Final warning label decided:", warningLabel);
              break;
            } else {
              console.warn("[MOD] OpenAI HTTP", r.status);
            }
          } catch (e) { console.warn("[MOD-KEY-FAIL]", e.message); }
        }
      }
    }

    // 3. Save the post
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

    if (mediaId) {
      await run("UPDATE media SET post_id=$1, processing_status='ready', visibility='public' WHERE id=$2 AND owner_id=$3", [postId, mediaId, me]);
    }

    const r = await query("SELECT p.*, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id=$1 LIMIT 1", [postId]);
    
    res.status(201).json({ success: true, post: r.rows[0] });
  } catch (err) {
    console.error("[MODERATION-POST-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
