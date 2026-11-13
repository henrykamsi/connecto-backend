const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// Remove every existing POST /messages handler
src = src.replace(
  /app\.post\(\s*["']\/api\/v1\/chat\/conversations\/:id\/messages(?:-v2)?["']\s*,[\s\S]*?\n\}\);\s*\n/g, ""
);

const block = `
/* [SEND-FIX-BULLETPROOF] */
app.post("/api/v1/chat/conversations/:id/messages", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const convId = req.params.id;
    const body = String(req.body.body || "").trim();
    const mediaUrl = req.body.media_url || null;
    const msgType = mediaUrl ? "image" : "text";
    if (!body && !mediaUrl) return res.status(400).json({ success: false, error: "EMPTY_MESSAGE" });

    const messageId = uuidv4();
    const nowIso = new Date().toISOString();
    
    await run(
      "INSERT INTO messages (id, conversation_id, sender_id, body, message_type, media_url, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [messageId, convId, me, body, msgType, mediaUrl, nowIso]
    );
    await run("UPDATE conversations SET updated_at=$1 WHERE id=$2", [nowIso, convId]);

    // Force strict boolean
    return res.status(201).json({
      success: true,
      messageId: messageId,
      conversationId: convId,
      body: body,
      media_url: mediaUrl,
      message_type: msgType,
      sent_at: nowIso
    });
  } catch (err) {
    console.error("[SEND-FIX-BULLETPROOF-CRASH]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
`;

src += block;

const tmp = "server_check_tmp.js";
fs.writeFileSync(tmp, src);
try { execSync("node --check " + tmp, { stdio: "pipe" }); console.log("[OK] Syntax valid"); }
catch (e) { console.error("[SYNTAX FAIL]", e.message); fs.unlinkSync(tmp); process.exit(1); }
fs.unlinkSync(tmp);
fs.writeFileSync("server.js", src);
console.log("[OK] server.js updated. Bottom handler wins.");
