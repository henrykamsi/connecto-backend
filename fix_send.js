const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// Remove every existing POST .../messages and GET .../messages-v2 handler
src = src.replace(
  /app\.post\(\s*["']\/api\/v1\/chat\/conversations\/:id\/messages["']\s*,\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\}\);\s*\n/g, ""
);
src = src.replace(
  /app\.get\(\s*["']\/api\/v1\/chat\/conversations\/:id\/messages-v2["']\s*,\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\}\);\s*\n/g, ""
);

const block = `
/* [SEND-FIX] */
const __sendAuth = (h) => {
  if (!h || !h.startsWith("Bearer ")) return null;
  try {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    return jwt.verify(h.slice(7), envLocal.jwt.secret).sub;
  } catch (_) { return null; }
};

app.post("/api/v1/chat/conversations/:id/messages", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");

    const me = __sendAuth(req.headers.authorization);
    if (!me) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });

    const convId = req.params.id;
    const body = String(req.body.body || "").trim();
    const mediaUrl = req.body.media_url || null;
    const msgType = mediaUrl ? "image" : "text";
    if (!body && !mediaUrl) return res.status(400).json({ success: false, error: "EMPTY_MESSAGE" });

    const member = await query(
      "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 LIMIT 1",
      [convId, me]
    );
    if (!member.rows.length) {
      return res.status(403).json({ success: false, error: "NOT_A_CONVERSATION_MEMBER" });
    }

    const messageId = uuidv4();
    const nowIso = new Date().toISOString();
    await run(
      "INSERT INTO messages (id, conversation_id, sender_id, body, message_type, media_url, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [messageId, convId, me, body, msgType, mediaUrl, nowIso]
    );
    await run(
      "UPDATE conversations SET updated_at=$1 WHERE id=$2",
      [nowIso, convId]
    );

    return res.status(201).json({
      success: true,
      messageId,
      conversationId: convId,
      body,
      media_url: mediaUrl,
      message_type: msgType,
      sent_at: nowIso
    });
  } catch (err) {
    console.error("[SEND-FIX-UNCAUGHT]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/chat/conversations/:id/messages-v2", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const me = __sendAuth(req.headers.authorization);
    if (!me) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });

    const member = await query(
      "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 LIMIT 1",
      [req.params.id, me]
    );
    if (!member.rows.length) return res.status(403).json({ success: false, error: "NOT_A_CONVERSATION_MEMBER" });

    const r = await query(
      "SELECT m.id, m.body, m.message_type, m.sender_id, m.sent_at, m.edited_at, m.deleted_at, m.media_url, m.read_at, m.delivered_at, u.username, u.first_name, u.surname, u.profile_photo_media_id FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id=$1 AND m.deleted_at IS NULL ORDER BY m.sent_at ASC LIMIT 200",
      [req.params.id]
    );
    return res.json({ success: true, messages: r.rows });
  } catch (err) {
    console.error("[SEND-FIX-GET-UNCAUGHT]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
`;

src += block;

const tmp = "server_check_tmp.js";
fs.writeFileSync(tmp, src);
try { execSync("node --check " + tmp, { stdio: "pipe" }); console.log("[OK] syntax"); }
catch (e) {
  console.error("[SYNTAX FAIL]", (e.stderr ? e.stderr.toString() : e.message).slice(0, 500));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);
fs.writeFileSync("server.js", src);
console.log("[OK] server.js updated");
