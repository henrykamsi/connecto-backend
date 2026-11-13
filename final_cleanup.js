const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// 1. Remove the rogue [AI-BULLETPROOF] interceptor that is overwriting the label
const aiBulletproofRegex = /\/\* \[AI-BULLETPROOF\] \*\/[\s\S]*?return originalJson\(body\);\s*\}\s*\};\s*\}\s*next\(\);\s*\}\);/g;
const beforeLen = src.length;
src = src.replace(aiBulletproofRegex, "");
console.log("[1] Removed [AI-BULLETPROOF] rogue interceptor. Bytes removed:", beforeLen - src.length);

// 2. Fix the heartbeat 500 (it tries to update a missing last_seen column)
const badHeartbeatRegex = /app\.post\("\/api\/v1\/heartbeat",[\s\S]*?\n\}\);/g;
const goodHeartbeat = `
app.post("/api/v1/heartbeat", async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false });
    let userId = null;
    try { userId = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false }); }
    const { run } = require("./src/db");
    try { await run("ALTER TABLE users ADD COLUMN last_seen TEXT"); } catch(e) {}
    await run("UPDATE users SET last_seen=CURRENT_TIMESTAMP WHERE id=$1", [userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
`;
src = src.replace(badHeartbeatRegex, goodHeartbeat);
console.log("[2] Fixed the heartbeat 500.");

// 3. Check syntax
fs.writeFileSync("server_check_tmp.js", src);
try {
  execSync("node --check server_check_tmp.js", { stdio: "pipe" });
  console.log("[3] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
fs.unlinkSync("server_check_tmp.js");
fs.writeFileSync("server.js", src);

console.log("4. Pushing to GitHub...");
execSync("git add -A && git commit -m 'fix: remove AI-BULLETPROOF, fix heartbeat 500' && git push origin main", { stdio: "inherit" });
console.log("DONE - wait 2 min for Render");
