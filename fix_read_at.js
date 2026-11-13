const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// 1. Remove any old broken read routes
src = src.replace(/app\.post\(\s*["']\/api\/v1\/messages\/:id\/read-v2["'][\s\S]*?\n\}\);/g, "");

// 2. Add the clean route
const readRoute = `
/* [READ-AT-FIX] */
app.post("/api/v1/messages/:id/read-v2", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const m = await query("SELECT conversation_id FROM messages WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    
    // Update the message to have delivered_at and read_at timestamps
    await run(
        "UPDATE messages SET read_at=COALESCE(read_at, CURRENT_TIMESTAMP), delivered_at=COALESCE(delivered_at, CURRENT_TIMESTAMP) WHERE id=$1 AND sender_id != $2",
        [req.params.id, me]
    );

    res.json({ success: true, read: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
`;

// 3. Add the GET messages-v2 route to ensure it returns the read_at column
src = src.replace(/app\.get\(\s*["']\/api\/v1\/chat\/conversations\/:id\/messages-v2["'][\s\S]*?\n\}\);/g, "");
const getRoute = `
/* [MESSAGES-V2-FIX] */
app.get("/api/v1/chat/conversations/:id/messages-v2", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const r = await query(
      "SELECT m.id, m.body, m.message_type, m.sender_id, m.sent_at, m.edited_at, m.deleted_at, m.media_url, m.read_at, m.delivered_at, u.username, u.first_name, u.surname, u.profile_photo_media_id FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id=$1 AND m.deleted_at IS NULL ORDER BY m.sent_at ASC LIMIT 200",
      [req.params.id]
    );
    
    res.json({ success: true, messages: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
`;

src = src + "\n\n" + readRoute + "\n\n" + getRoute;
fs.writeFileSync("server.js", src);
console.log("[1] Added read-v2 and messages-v2 routes to server.js");

try {
  execSync("node --check server.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
