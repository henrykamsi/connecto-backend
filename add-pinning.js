const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[PIN-ENDPOINTS]")) {
  console.log("SKIP: pinning already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';
if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [PIN-ENDPOINTS] Pin / unpin one post per user */
app.post("/api/v1/posts/:id/pin", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const postId = req.params.id;
    const p = await query("SELECT id FROM posts WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL LIMIT 1", [postId, userId]);
    if (!p.rows.length) return res.status(404).json({ success: false, error: "POST_NOT_FOUND_OR_NOT_OWNER" });

    try { await run("ALTER TABLE users ADD COLUMN pinned_post_id TEXT"); } catch (e) {}

    await run("UPDATE users SET pinned_post_id=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [postId, userId]);

    res.json({ success: true, pinned_post_id: postId });
  } catch (err) {
    console.error("[PIN-POST]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/posts/:id/pin", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    await run("UPDATE users SET pinned_post_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND pinned_post_id=$2", [userId, req.params.id]);

    res.json({ success: true, unpinned: true });
  } catch (err) {
    console.error("[UNPIN-POST]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* [PIN-ENDPOINTS] ensure column exists on boot */
(async () => {
  try {
    const { run } = require("./src/db");
    try { await run("ALTER TABLE users ADD COLUMN pinned_post_id TEXT"); } catch (e) {}
    console.log("[PIN] users.pinned_post_id ready");
  } catch (e) {
    console.error("[PIN] schema:", e.message);
  }
})();

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: pin/unpin endpoints added");
