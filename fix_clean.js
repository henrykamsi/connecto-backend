const fs = require("fs");
const { execSync } = require("child_process");

// 1. Revert the broken syntax in server.js from the last attempt
let src = fs.readFileSync("server.js", "utf8");
const brokenBlock = src.indexOf("// [DIRECT-GPT-MODERATION]");
if (brokenBlock !== -1) {
  // Find the end of the broken block (roughly)
  const endOfBroken = src.indexOf("res.status(201).json({ success: true, post: result.rows[0] });", brokenBlock);
  if (endOfBroken !== -1) {
    src = src.slice(0, brokenBlock) + src.slice(endOfBroken + 70);
    fs.writeFileSync("server.js", src);
    console.log("[1] Reverted broken syntax in server.js");
  }
}

// 2. Create the new modular moderation file
const modFile = `
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
    if (!text) return res.status(400).json({ success: false, error: "POST_CONTENT_REQUIRED" });

    // Run GPT Moderation
    let warningLabel = null;
    const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    if (keys.length > 0) {
      const payload = JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "text", text: text }] });
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
            if (cats["sexual"] || cats["sexual/minors"]) warningLabel = "NUDITY CONTENT (18+)";
            else if (cats["violence"] || cats["violence/graphic"]) warningLabel = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
            else if (cats["self-harm"]) warningLabel = "DO NOT TRY THIS";
            else if (cats["harassment"] || cats["hate"]) warningLabel = "INAPPROPRIATE CONTENT";
            break;
          }
        } catch (e) { console.warn("[MOD-KEY-FAIL]", e.message); }
      }
    }

    const postId = uuidv4();
    const visibility = req.body.visibility || "public";
    const commentsEnabled = req.body.commentsEnabled !== false ? 1 : 0;
    const shareEnabled = req.body.shareEnabled !== false ? 1 : 0;
    const isAiContent = req.body.is_ai_content ? 1 : 0;
    const warningStyle = warningLabel ? "danger" : null;

    await run(
      "INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, is_ai_content, warning_label, warning_label_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [postId, me, text, visibility, commentsEnabled, shareEnabled, isAiContent, warningLabel, warningStyle]
    );

    const r = await query("SELECT p.*, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id=$1 LIMIT 1", [postId]);
    
    res.status(201).json({ success: true, post: r.rows[0] });
  } catch (err) {
    console.error("[MODERATION-POST-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
`;

fs.writeFileSync("moderation.js", modFile);
console.log("[2] Created clean moderation.js");

// 3. Mount it in server.js at the very top, before everything else
src = fs.readFileSync("server.js", "utf8");
if (!src.includes('require("./moderation")')) {
  const mountPoint = 'app.use(express.json({ limit: "10mb" }));';
  if (src.includes(mountPoint)) {
    src = src.replace(mountPoint, mountPoint + '\napp.use("/api/v1/posts", require("./moderation"));\n');
    fs.writeFileSync("server.js", src);
    console.log("[3] Mounted moderation.js in server.js");
  } else {
    console.error("[3] Could not find express.json mount point.");
  }
}

try {
  execSync("node --check server.js", { stdio: "pipe" });
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
