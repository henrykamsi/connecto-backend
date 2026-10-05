const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "control-server.js");

if (!fs.existsSync(target)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");

if (src.includes("[CONTROL] new endpoints ready")) {
  console.log("SKIP: endpoints already present.");
  process.exit(0);
}

const anchor = "console.log(\"[CONTROL-SERVER] loaded \" + (router.stack.filter(l=>l.route).length) + \" routes\");";

if (!src.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `/* ============================================================================
 * NEW ENDPOINTS - Users, Revoke, Verification, Broadcast, Moderation
 * ==========================================================================*/

/* ---------- USER SEARCH ---------- */
router.get("/users/search", controlAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) {
      const r = await query("SELECT id, email, username, first_name, surname, is_verified, is_owner, account_status FROM users ORDER BY created_at DESC LIMIT $1", [limit]);
      return res.json({ success: true, users: r.rows });
    }
    const r = await query(
      "SELECT id, email, username, first_name, surname, is_verified, is_owner, account_status FROM users WHERE lower(email) LIKE lower($1) OR lower(username) LIKE lower($1) LIMIT $2",
      ["%" + q + "%", limit]
    );
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- USER BLOCK ---------- */
router.post("/users/:id/block", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const duration = String(req.body.duration || "forever");
    const reason = String(req.body.reason || "").trim();
    let expiresAt = null;
    const now = Date.now();
    if (duration === "1min") expiresAt = new Date(now + 60000).toISOString();
    else if (duration === "1hour") expiresAt = new Date(now + 3600000).toISOString();
    else if (duration === "24hours") expiresAt = new Date(now + 86400000).toISOString();
    else if (duration === "7days") expiresAt = new Date(now + 604800000).toISOString();
    else if (duration === "30days") expiresAt = new Date(now + 2592000000).toISOString();
    await run("INSERT INTO user_blocks (id, user_id, duration, reason, blocked_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuidv4(), userId, duration, reason, req.admin.id, expiresAt]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_BLOCKED", targetType: "user", targetId: userId, newValue: { duration, reason }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- USER SUSPEND ---------- */
router.post("/users/:id/suspend", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const duration = String(req.body.duration || "30days");
    const reason = String(req.body.reason || "").trim();
    let expiresAt = null;
    const now = Date.now();
    if (duration === "1day") expiresAt = new Date(now + 86400000).toISOString();
    else if (duration === "7days") expiresAt = new Date(now + 604800000).toISOString();
    else if (duration === "30days") expiresAt = new Date(now + 2592000000).toISOString();
    else if (duration === "60days") expiresAt = new Date(now + 5184000000).toISOString();
    else if (duration === "90days") expiresAt = new Date(now + 7776000000).toISOString();
    else if (duration === "180days") expiresAt = new Date(now + 15552000000).toISOString();
    else if (duration === "365days") expiresAt = new Date(now + 31536000000).toISOString();
    await run("INSERT INTO user_suspensions (id, user_id, duration, reason, suspended_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuidv4(), userId, duration, reason, req.admin.id, expiresAt]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_SUSPENDED", targetType: "user", targetId: userId, newValue: { duration, reason }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- USER RESTRICT ---------- */
router.post("/users/:id/restrict", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const restrictions = req.body.restrictions || [];
    const duration = String(req.body.duration || "30days");
    if (!Array.isArray(restrictions) || !restrictions.length) {
      return res.status(400).json({ success: false, error: "At least one restriction required" });
    }
    let expiresAt = null;
    const now = Date.now();
    if (duration === "1day") expiresAt = new Date(now + 86400000).toISOString();
    else if (duration === "7days") expiresAt = new Date(now + 604800000).toISOString();
    else if (duration === "30days") expiresAt = new Date(now + 2592000000).toISOString();
    else if (duration === "90days") expiresAt = new Date(now + 7776000000).toISOString();
    await run("INSERT INTO user_restrictions (id, user_id, restrictions, duration, restricted_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuidv4(), userId, JSON.stringify(restrictions), duration, req.admin.id, expiresAt]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_RESTRICTED", targetType: "user", targetId: userId, newValue: { restrictions, duration }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- SEND VERIFICATION ---------- */
router.post("/users/:id/verify-send", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const message = String(req.body.message || "You have been verified.").trim();
    await run("INSERT INTO pending_verifications (id, user_id, message) VALUES ($1,$2,$3)",
      [uuidv4(), userId, message]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_SENT", targetType: "user", targetId: userId, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- REVOKE ENDPOINTS ---------- */
router.post("/users/:id/revoke-block", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM user_blocks WHERE user_id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BLOCK_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/revoke-suspend", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM user_suspensions WHERE user_id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "SUSPENSION_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/revoke-restrict", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM user_restrictions WHERE user_id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "RESTRICTION_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/revoke-verify", controlAuth, async (req, res) => {
  try {
    await run("UPDATE users SET is_verified=0, verified_label=NULL WHERE id=$1", [req.params.id]);
    await run("DELETE FROM pending_verifications WHERE user_id=$1 AND status='pending'", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- LIST ENDPOINTS FOR REVOKE TAB ---------- */
router.get("/users/blocked", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT u.id, u.email, u.username, u.first_name, u.surname, b.duration, b.reason, b.blocked_at FROM user_blocks b JOIN users u ON u.id = b.user_id ORDER BY b.blocked_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/users/suspended", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT u.id, u.email, u.username, u.first_name, u.surname, s.duration, s.reason, s.suspended_at FROM user_suspensions s JOIN users u ON u.id = s.user_id ORDER BY s.suspended_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/users/restricted", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT u.id, u.email, u.username, u.first_name, u.surname, r.restrictions, r.duration, r.restricted_at FROM user_restrictions r JOIN users u ON u.id = r.user_id ORDER BY r.restricted_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/users/verified", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, email, username, first_name, surname, verified_label FROM users WHERE is_verified=1 ORDER BY updated_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- FOLLOWERS ADD / REMOVE ---------- */
router.post("/users/:id/followers/add", controlAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });
    const cur = await query("SELECT display_followers FROM users WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    const current = Number(cur.rows[0].display_followers || 0);
    await run("UPDATE users SET display_followers=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [current + amount, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "FOLLOWERS_ADDED", targetType: "user", targetId: req.params.id, newValue: { amount }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, newTotal: current + amount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/followers/remove", controlAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });
    const cur = await query("SELECT display_followers FROM users WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    const current = Number(cur.rows[0].display_followers || 0);
    if (current < amount) {
      return res.status(400).json({ success: false, error: "USER_DOES_NOT_HAVE_ENOUGH_FOLLOWERS", current });
    }
    await run("UPDATE users SET display_followers=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [current - amount, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "FOLLOWERS_REMOVED", targetType: "user", targetId: req.params.id, newValue: { amount }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, newTotal: current - amount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- VERIFICATION REQUESTS ---------- */
router.get("/verification-requests", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT * FROM verification_requests ORDER BY created_at DESC LIMIT 100");
    res.json({ success: true, requests: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/verification-requests/:id/approve", controlAuth, async (req, res) => {
  try {
    const vr = await query("SELECT * FROM verification_requests WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!vr.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    const userId = vr.rows[0].user_id;
    const { v4: uuidv4 } = require("uuid");
    await run("UPDATE verification_requests SET status='approved', reviewed_by=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2", [req.admin.id, req.params.id]);
    await run("INSERT INTO pending_verifications (id, user_id, message) VALUES ($1,$2,$3)",
      [uuidv4(), userId, "Your verification has been approved."]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_APPROVED", targetType: "user", targetId: userId, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/verification-requests/:id/decline", controlAuth, async (req, res) => {
  try {
    await run("UPDATE verification_requests SET status='declined', reviewed_by=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2", [req.admin.id, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_DECLINED", targetType: "verification_request", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- BROADCAST ---------- */
router.post("/broadcast", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();
    if (!title || !body) return res.status(400).json({ success: false, error: "TITLE_AND_BODY_REQUIRED" });
    let sentCount = 0, failCount = 0;
    try {
      const tokens = await query("SELECT token FROM device_tokens WHERE active=1");
      const list = tokens.rows.map(t => t.token).filter(Boolean);
      if (list.length) {
        const admin = require("firebase-admin");
        if (admin.apps.length) {
          const r = await admin.messaging().sendEachForMulticast({
            tokens: list,
            notification: { title, body }
          });
          sentCount = r.successCount || 0;
          failCount = r.failureCount || 0;
        }
      }
    } catch (e) { console.error("[BROADCAST-FCM]", e.message); }
    const id = uuidv4();
    await run("INSERT INTO broadcasts (id, title, body, sent_by, sent_count, fail_count) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, title, body, req.admin.id, sentCount, failCount]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BROADCAST_SENT", targetType: "broadcast", targetId: id, newValue: { title, sentCount, failCount }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, sent: sentCount, failed: failCount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/broadcasts", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50");
    res.json({ success: true, broadcasts: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- CONTENT MODERATION ---------- */
router.get("/content/posts", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100");
    res.json({ success: true, items: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/content/videos", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' LIMIT 1) AS media_url FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100");
    res.json({ success: true, items: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/content/images", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='image' LIMIT 1) AS media_url FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100");
    res.json({ success: true, items: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete("/content/:id", controlAuth, async (req, res) => {
  try {
    await run("UPDATE posts SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "CONTENT_DELETED", targetType: "post", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/content/:id/label", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const text = String(req.body.text || "").trim();
    const style = String(req.body.style || "faded");
    if (!text) return res.status(400).json({ success: false, error: "TEXT_REQUIRED" });
    await run("INSERT INTO warning_labels (id, post_id, text, style, added_by) VALUES ($1,$2,$3,$4,$5)",
      [uuidv4(), req.params.id, text, style, req.admin.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "LABEL_ADDED", targetType: "post", targetId: req.params.id, newValue: { text, style }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- BANNED WORDS ---------- */
router.get("/banned-words", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT * FROM banned_words ORDER BY created_at DESC LIMIT 500");
    res.json({ success: true, words: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/banned-words", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const word = String(req.body.word || "").trim().toLowerCase();
    if (!word) return res.status(400).json({ success: false, error: "WORD_REQUIRED" });
    await run("INSERT INTO banned_words (id, word, added_by) VALUES ($1,$2,$3) ON CONFLICT(word) DO NOTHING",
      [uuidv4(), word, req.admin.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BANNED_WORD_ADDED", targetType: "banned_word", targetId: word, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete("/banned-words/:id", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM banned_words WHERE id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BANNED_WORD_REMOVED", targetType: "banned_word", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

console.log("[CONTROL] new endpoints ready");

`;

src = src.replace(anchor, block + anchor);
fs.writeFileSync(target, src);
console.log("OK: endpoints inserted above route count log");
