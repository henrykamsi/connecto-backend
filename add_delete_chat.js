const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

if (!modSrc.includes('router.delete("/chat/conversations/:id"')) {
  const deleteRoute = `
// DELETE /api/v1/chat/conversations/:id
router.delete("/chat/conversations/:id", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { 
        const jwt = require("jsonwebtoken");
        const envLocal = require("./src/config/env");
        me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; 
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const convId = req.params.id;
    
    // Verify user is part of the conversation
    const member = await query("SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 LIMIT 1", [convId, me]);
    if (!member.rows.length) return res.status(403).json({ success: false, error: "NOT_A_MEMBER" });

    // Wipe from DB
    await run("DELETE FROM messages WHERE conversation_id=$1", [convId]);
    await run("DELETE FROM conversation_members WHERE conversation_id=$1", [convId]);
    await run("DELETE FROM conversations WHERE id=$1", [convId]);

    res.json({ success: true, message: "Conversation deleted" });
  } catch (err) {
    console.error("[DELETE-CHAT-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
`;
  modSrc = modSrc.replace("module.exports = router;", deleteRoute + "\nmodule.exports = router;");
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Added DELETE /chat/conversations to moderation.js");
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
