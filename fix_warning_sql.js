const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// Find the broken SQL query inside the /warnings route
const oldQuery = `"SELECT id, text, warning_label, warning_label_style, created_at FROM posts WHERE author_id=$1 AND warning_label IS NOT NULL ORDER BY created_at DESC"`;
const newQuery = `"SELECT id, text, warning_label, warning_label_style, created_at FROM posts WHERE author_id=$1 AND warning_label IS NOT NULL ORDER BY created_at DESC"`;

// Check if the file contains media_url anywhere in the warnings route
if (modSrc.includes("media_url")) {
    // Replace any mention of media_url in the SELECT statement
    modSrc = modSrc.replace(/SELECT id, text, media_url, media_type, warning_label, warning_label_style, created_at FROM posts/g, 
        "SELECT id, text, warning_label, warning_label_style, created_at FROM posts");
        
    modSrc = modSrc.replace(/SELECT id, text, media_url, warning_label, warning_label_style, created_at FROM posts/g, 
        "SELECT id, text, warning_label, warning_label_style, created_at FROM posts");
        
    modSrc = modSrc.replace(/media_url, media_type, /g, "");
    modSrc = modSrc.replace(/media_url, /g, "");
    
    fs.writeFileSync("moderation.js", modSrc);
    console.log("[1] Removed media_url from the warnings query");
} else {
    console.log("[1] No media_url found in the query. Checking for alternate broken query...");
    // If the query was manually altered, do a hard fix
    const brokenSelect = /router\.get\("\/warnings"[\s\S]*?const r = await query\([\s\S]*?\);/;
    if (brokenSelect.test(modSrc)) {
        const fixedRoute = `
router.get("/warnings", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { 
        const jwt = require("jsonwebtoken");
        const envLocal = require("./src/config/env");
        me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; 
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const r = await query(
      "SELECT id, text, warning_label, warning_label_style, created_at FROM posts WHERE author_id=$1 AND warning_label IS NOT NULL ORDER BY created_at DESC",
      [me]
    );
    
    res.json({ success: true, warnings: r.rows });
  } catch (err) {
    console.error("[MODERATION-GET-WARNINGS-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});`;
        modSrc = modSrc.replace(brokenSelect, fixedRoute);
        fs.writeFileSync("moderation.js", modSrc);
        console.log("[1] Re-wrote the /warnings route with the correct query.");
    } else {
        console.log("[1] Could not find the /warnings route to fix.");
    }
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
