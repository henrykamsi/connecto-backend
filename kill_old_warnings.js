const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// 1. Find and remove EVERY existing moderation/warnings route in server.js
const oldRoute1 = /app\.get\(\s*["']\/api\/v1\/moderation\/warnings["'][\s\S]*?\n\}\);/g;
const oldRoute2 = /router\.get\(\s*["']\/warnings["'][\s\S]*?\n\}\);/g;

const beforeLen = src.length;
src = src.replace(oldRoute1, "");
src = src.replace(oldRoute2, "");
console.log("[1] Removed old moderation/warnings routes from server.js. Bytes removed:", beforeLen - src.length);

// 2. Force a clean, working route at the very top of server.js (before everything else)
const newRoute = `
/* [WARNINGS-FIX-FINAL] */
app.get("/api/v1/moderation/warnings", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const r = await query(
      "SELECT id, text, warning_label, warning_label_style, created_at FROM posts WHERE author_id=$1 AND warning_label IS NOT NULL ORDER BY created_at DESC",
      [me]
    );
    
    res.json({ success: true, warnings: r.rows });
  } catch (err) {
    console.error("[WARNINGS-FIX-FINAL-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
`;

// Insert right after express.json so it catches the request before the old ones
const anchor = /app\.use\(express\.json\(\s*\{[\s\S]*?\}\s*\)\);/;
if (src.match(anchor)) {
  src = src.replace(anchor, match => match + "\n\n" + newRoute);
  console.log("[2] Injected clean /warnings route at the top of server.js");
} else {
  src = newRoute + "\n\n" + src;
  console.log("[2] Injected clean /warnings route at top of file (fallback)");
}

fs.writeFileSync("server_check_tmp.js", src);
try {
  execSync("node --check server_check_tmp.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
fs.unlinkSync("server_check_tmp.js");
fs.writeFileSync("server.js", src);

console.log("3. Pushing to GitHub...");
execSync("git add -A && git commit -m 'fix: remove all old warnings routes, inject clean one at top' && git push origin main", { stdio: "inherit" });
console.log("DONE - wait 2 min");
