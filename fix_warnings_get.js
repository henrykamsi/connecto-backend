const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// 1. Check if the GET route already exists. If not, add it.
if (!modSrc.includes('router.get("/warnings"') && !modSrc.includes("router.get('/warnings'")) {
  
  const getRoute = `
// GET /api/v1/moderation/warnings
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

    // Fetch all posts for this user that have a warning label
    const r = await query(
      "SELECT id, text, warning_label, warning_label_style, created_at FROM posts WHERE author_id=$1 AND warning_label IS NOT NULL ORDER BY created_at DESC",
      [me]
    );
    
    res.json({ success: true, warnings: r.rows });
  } catch (err) {
    console.error("[MODERATION-GET-WARNINGS-ERROR]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/v1/moderation/warnings/:id/delete
router.post("/warnings/:id/delete", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub;
    
    // Hard delete the warning post
    await run("DELETE FROM posts WHERE id=$1 AND author_id=$2", [req.params.id, me]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/moderation/warnings/:id/override
router.post("/warnings/:id/override", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub;
    
    // Remove the warning label
    await run("UPDATE posts SET warning_label=NULL, warning_label_style=NULL WHERE id=$1 AND author_id=$2", [req.params.id, me]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
`;

  modSrc = modSrc.replace("module.exports = router;", getRoute + "\nmodule.exports = router;");
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Added GET /warnings and DELETE/OVERRIDE routes to moderation.js");
} else {
  console.log("[1] Routes already exist in moderation.js");
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
