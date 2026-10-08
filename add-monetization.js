const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[MONETIZATION]")) {
  console.log("SKIP: monetization already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';
if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [MONETIZATION] schema + endpoints */

(async () => {
  try {
    const { run } = require("./src/db");

    await run("CREATE TABLE IF NOT EXISTS stars_config (user_id TEXT PRIMARY KEY, price_ngn INTEGER NOT NULL DEFAULT 1000, button_label TEXT NOT NULL DEFAULT 'Support us', enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

    await run("CREATE TABLE IF NOT EXISTS stars_supporters (id TEXT PRIMARY KEY, supporter_id TEXT NOT NULL, creator_id TEXT NOT NULL, amount_ngn INTEGER NOT NULL, platform_fee_ngn INTEGER NOT NULL, creator_share_ngn INTEGER NOT NULL, squad_reference TEXT, status TEXT NOT NULL DEFAULT 'pending', paid_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE INDEX IF NOT EXISTS idx_stars_supp_creator ON stars_supporters(creator_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_stars_supp_supporter ON stars_supporters(supporter_id)");

    await run("CREATE TABLE IF NOT EXISTS monetization_choice (user_id TEXT PRIMARY KEY, active_method TEXT, enabled_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

    await run("CREATE TABLE IF NOT EXISTS ad_revenue_config (user_id TEXT PRIMARY KEY, button_label TEXT NOT NULL DEFAULT 'Support by watching an ad', enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

    await run("CREATE TABLE IF NOT EXISTS ad_revenue_clicks (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, visitor_id TEXT NOT NULL, counted INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE INDEX IF NOT EXISTS idx_adrev_creator ON ad_revenue_clicks(creator_id)");

    await run("CREATE TABLE IF NOT EXISTS referral_codes (user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE INDEX IF NOT EXISTS idx_ref_code ON referral_codes(code)");

    await run("CREATE TABLE IF NOT EXISTS referral_progress (id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, invitee_id TEXT NOT NULL UNIQUE, stage TEXT NOT NULL DEFAULT 'signed_up', posted INTEGER NOT NULL DEFAULT 0, stayed_3min INTEGER NOT NULL DEFAULT 0, engaged INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE INDEX IF NOT EXISTS idx_ref_inviter ON referral_progress(inviter_id)");

    await run("CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY, balance_ngn INTEGER NOT NULL DEFAULT 0, threshold_ngn INTEGER NOT NULL DEFAULT 7500, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

    await run("CREATE TABLE IF NOT EXISTS wallet_transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_ngn INTEGER NOT NULL, type TEXT NOT NULL, reference TEXT, description TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id)");

    await run("CREATE TABLE IF NOT EXISTS withdrawal_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_ngn INTEGER NOT NULL, bank_code TEXT NOT NULL, account_number TEXT NOT NULL, account_name TEXT, squad_reference TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT)");
    await run("CREATE INDEX IF NOT EXISTS idx_withdraw_user ON withdrawal_requests(user_id)");

    await run("CREATE TABLE IF NOT EXISTS device_locks (id TEXT PRIMARY KEY, device_fingerprint TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, locked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE INDEX IF NOT EXISTS idx_device_lock_fp ON device_locks(device_fingerprint)");

    try { await run("ALTER TABLE users ADD COLUMN monetization_enabled INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
    try { await run("ALTER TABLE users ADD COLUMN ad_revenue_enabled INTEGER NOT NULL DEFAULT 0"); } catch (e) {}

    console.log("[MONETIZATION] schema ready");
  } catch (e) {
    console.error("[MONETIZATION] schema:", e.message);
  }
})();

function monetizationAuth() {
  return async function (req, res, next) {
    try {
      const jwt = require("jsonwebtoken");
      const envLocal = require("./src/config/env");
      const { query } = require("./src/db");
      const h = req.headers.authorization || "";
      if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
      const p = jwt.verify(h.slice(7), envLocal.jwt.secret);
      const u = await query("SELECT id, email, first_name, surname, username, created_at FROM users WHERE id=$1 LIMIT 1", [p.sub]);
      if (!u.rows.length) return res.status(401).json({ success: false, error: "USER_NOT_FOUND" });
      req.user = u.rows[0];
      next();
    } catch (e) {
      res.status(401).json({ success: false, error: "INVALID_SESSION" });
    }
  };
}

async function checkCriteria(userId, method) {
  const { query } = require("./src/db");
  const u = await query("SELECT id, created_at FROM users WHERE id=$1 LIMIT 1", [userId]);
  if (!u.rows.length) return { ok: false, criteria: {} };
  const createdAt = new Date(u.rows[0].created_at);

  const posts = await query("SELECT COUNT(*) AS c FROM posts WHERE author_id=$1 AND deleted_at IS NULL", [userId]);
  const videos = await query("SELECT COUNT(*) AS c FROM posts WHERE author_id=$1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=posts.id AND m.type='video' AND m.deleted_at IS NULL)", [userId]);
  const likes = await query("SELECT COUNT(*) AS c FROM reactions WHERE user_id=$1", [userId]);
  const comments = await query("SELECT COUNT(DISTINCT post_id) AS c FROM comments WHERE author_id=$1 AND deleted_at IS NULL", [userId]);
  const follows = await query("SELECT COUNT(*) AS c FROM follows WHERE follower_id=$1", [userId]);
  const friends = await query("SELECT COUNT(*) AS c FROM friendships WHERE user_a_id=$1 OR user_b_id=$1", [userId]);

  const adViews = await query("SELECT COUNT(*) AS c FROM ad_revenue_clicks WHERE visitor_id=$1", [userId]);

  const postsN = Number(posts.rows[0].c || 0);
  const videosN = Number(videos.rows[0].c || 0);
  const likesN = Number(likes.rows[0].c || 0);
  const commentsN = Number(comments.rows[0].c || 0);
  const followsN = Number(follows.rows[0].c || 0);
  const friendsN = Number(friends.rows[0].c || 0);
  const adViewsN = Number(adViews.rows[0].c || 0);
  const daysOld = Math.floor((Date.now() - createdAt.getTime()) / 86400000);

  if (method === "stars") {
    const c = {
      videos3: videosN >= 3,
      days3: daysOld >= 3,
      ads2: adViewsN >= 2,
      like1: likesN >= 1,
      comment1: commentsN >= 1,
      follow1: followsN >= 1
    };
    return { ok: Object.values(c).every(Boolean), criteria: c };
  }
  if (method === "ad_revenue") {
    const c = {
      posts3: postsN >= 3,
      days2: daysOld >= 2,
      ads2: adViewsN >= 2,
      follows3: followsN >= 3,
      likes5: likesN >= 5,
      comments2: commentsN >= 2,
      friends1: friendsN >= 1
    };
    return { ok: Object.values(c).every(Boolean), criteria: c };
  }
  if (method === "invite") {
    const c = {
      posts1: postsN >= 1,
      follows1: followsN >= 1,
      likes5: likesN >= 5,
      comments2: commentsN >= 2
    };
    return { ok: Object.values(c).every(Boolean), criteria: c };
  }
  return { ok: false, criteria: {} };
}

async function ensureWallet(userId) {
  const { query, run } = require("./src/db");
  const w = await query("SELECT * FROM wallets WHERE user_id=$1 LIMIT 1", [userId]);
  if (!w.rows.length) {
    await run("INSERT INTO wallets (user_id, balance_ngn, threshold_ngn) VALUES ($1, 0, 7500)", [userId]);
    const w2 = await query("SELECT * FROM wallets WHERE user_id=$1 LIMIT 1", [userId]);
    return w2.rows[0];
  }
  return w.rows[0];
}

function generateReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

app.get("/api/v1/monetization/status", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const r = await query("SELECT value FROM feature_flags WHERE key='monetization_enabled' LIMIT 1").catch(() => ({ rows: [] }));
    const enabled = r.rows.length ? String(r.rows[0].value) === "true" : true;
    res.json({ success: true, enabled });
  } catch (e) {
    res.json({ success: true, enabled: true });
  }
});

app.get("/api/v1/monetization/me", monetizationAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const uid = req.user.id;
    const stars = await query("SELECT * FROM stars_config WHERE user_id=$1 LIMIT 1", [uid]).catch(() => ({ rows: [] }));
    const adrev = await query("SELECT * FROM ad_revenue_config WHERE user_id=$1 LIMIT 1", [uid]).catch(() => ({ rows: [] }));
    const choice = await query("SELECT * FROM monetization_choice WHERE user_id=$1 LIMIT 1", [uid]).catch(() => ({ rows: [] }));
    const ref = await query("SELECT code FROM referral_codes WHERE user_id=$1 LIMIT 1", [uid]).catch(() => ({ rows: [] }));
    const wallet = await ensureWallet(uid);
    res.json({
      success: true,
      stars: stars.rows[0] || null,
      ad_revenue: adrev.rows[0] || null,
      active_method: choice.rows[0]?.active_method || null,
      referral_code: ref.rows[0]?.code || null,
      wallet
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/v1/stars/criteria", monetizationAuth(), async (req, res) => {
  try {
    const result = await checkCriteria(req.user.id, "stars");
    res.json({ success: true, met: result.ok, criteria: result.criteria });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/stars/enable", monetizationAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const uid = req.user.id;
    const result = await checkCriteria(uid, "stars");
    if (!result.ok) return res.status(403).json({ success: false, error: "CRITERIA_NOT_MET", criteria: result.criteria });
    const price = Math.max(100, Number(req.body.price_ngn || 1000));
    const label = String(req.body.button_label || "Support us").slice(0, 40);
    await run("INSERT INTO stars_config (user_id, price_ngn, button_label, enabled) VALUES ($1, $2, $3, 1) ON CONFLICT(user_id) DO UPDATE SET price_ngn=excluded.price_ngn, button_label=excluded.button_label, enabled=1, updated_at=CURRENT_TIMESTAMP", [uid, price, label]);
    await run("INSERT INTO monetization_choice (user_id, active_method, enabled_at) VALUES ($1, 'stars', CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET active_method='stars', enabled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP", [uid]);
    await run("UPDATE users SET monetization_enabled=1 WHERE id=$1", [uid]);
    await ensureWallet(uid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/stars/price", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const price = Math.max(100, Number(req.body.price_ngn || 1000));
    await run("UPDATE stars_config SET price_ngn=$1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2", [price, req.user.id]);
    res.json({ success: true, price_ngn: price });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/stars/button-label", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const label = String(req.body.button_label || "Support us").slice(0, 40);
    await run("UPDATE stars_config SET button_label=$1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2", [label, req.user.id]);
    res.json({ success: true, button_label: label });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/stars/cancel", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const uid = req.user.id;
    await run("UPDATE stars_config SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=$1", [uid]);
    await run("UPDATE users SET monetization_enabled=0 WHERE id=$1", [uid]);
    await run("UPDATE monetization_choice SET active_method=NULL, updated_at=CURRENT_TIMESTAMP WHERE user_id=$1", [uid]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/stars/wallet", monetizationAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const uid = req.user.id;
    const wallet = await ensureWallet(uid);
    const tx = await query("SELECT * FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [uid]);
    res.json({ success: true, wallet, transactions: tx.rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/stars/supporters", monetizationAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const uid = req.user.id;
    const r = await query("SELECT s.*, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM stars_supporters s JOIN users u ON u.id = s.supporter_id WHERE s.creator_id=$1 AND s.status='paid' ORDER BY s.paid_at DESC LIMIT 200", [uid]);
    const total = await query("SELECT COALESCE(SUM(creator_share_ngn),0) AS total FROM stars_supporters WHERE creator_id=$1 AND status='paid'", [uid]);
    res.json({ success: true, supporters: r.rows, total_earned_ngn: Number(total.rows[0].total || 0) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/stars/support/init", monetizationAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const creatorId = String(req.body.creator_id || "").trim();
    if (!creatorId) return res.status(400).json({ success: false, error: "CREATOR_ID_REQUIRED" });
    if (creatorId === req.user.id) return res.status(400).json({ success: false, error: "CANNOT_SUPPORT_SELF" });

    const cfg = await query("SELECT * FROM stars_config WHERE user_id=$1 AND enabled=1 LIMIT 1", [creatorId]);
    if (!cfg.rows.length) return res.status(404).json({ success: false, error: "STARS_NOT_ENABLED" });

    const amount = Number(cfg.rows[0].price_ngn || 1000);
    const platformFee = Math.floor(amount * 0.30);
    const creatorShare = amount - platformFee;
    const reference = "connecto-star-" + uuidv4();

    await run("INSERT INTO stars_supporters (id, supporter_id, creator_id, amount_ngn, platform_fee_ngn, creator_share_ngn, squad_reference, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')", [uuidv4(), req.user.id, creatorId, amount, platformFee, creatorShare, reference]);

    let checkoutUrl = null;
    try {
      const squad = require("./src/providers/squad");
      checkoutUrl = await squad.initTransaction({
        email: req.user.email,
        amountKobo: amount * 100,
        reference,
        callbackUrl: "connecto://payment-return?ref=" + reference
      });
    } catch (e) {
      console.error("[STARS-INIT-SQUAD]", e.message);
    }

    res.json({
      success: true,
      reference,
      amount_ngn: amount,
      creator_share_ngn: creatorShare,
      platform_fee_ngn: platformFee,
      checkout_url: checkoutUrl
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/ad-revenue/criteria", monetizationAuth(), async (req, res) => {
  try {
    const result = await checkCriteria(req.user.id, "ad_revenue");
    res.json({ success: true, met: result.ok, criteria: result.criteria });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/ad-revenue/enable", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const uid = req.user.id;
    const result = await checkCriteria(uid, "ad_revenue");
    if (!result.ok) return res.status(403).json({ success: false, error: "CRITERIA_NOT_MET", criteria: result.criteria });
    const label = String(req.body.button_label || "Support by watching an ad").slice(0, 50);
    await run("INSERT INTO ad_revenue_config (user_id, button_label, enabled) VALUES ($1, $2, 1) ON CONFLICT(user_id) DO UPDATE SET button_label=excluded.button_label, enabled=1, updated_at=CURRENT_TIMESTAMP", [uid, label]);
    await run("INSERT INTO monetization_choice (user_id, active_method, enabled_at) VALUES ($1, 'ad_revenue', CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET active_method='ad_revenue', enabled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP", [uid]);
    await run("UPDATE users SET ad_revenue_enabled=1 WHERE id=$1", [uid]);
    await ensureWallet(uid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/ad-revenue/button-label", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const label = String(req.body.button_label || "Support by watching an ad").slice(0, 50);
    await run("UPDATE ad_revenue_config SET button_label=$1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2", [label, req.user.id]);
    res.json({ success: true, button_label: label });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/ad-revenue/cancel", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    const uid = req.user.id;
    await run("UPDATE ad_revenue_config SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=$1", [uid]);
    await run("UPDATE users SET ad_revenue_enabled=0 WHERE id=$1", [uid]);
    await run("UPDATE monetization_choice SET active_method=NULL, updated_at=CURRENT_TIMESTAMP WHERE user_id=$1", [uid]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/ad-revenue/log-view", monetizationAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const creatorId = String(req.body.creator_id || "").trim();
    if (!creatorId) return res.status(400).json({ success: false, error: "CREATOR_ID_REQUIRED" });
    if (creatorId === req.user.id) return res.status(400).json({ success: false, error: "CANNOT_SUPPORT_SELF" });

    const cfg = await query("SELECT * FROM ad_revenue_config WHERE user_id=$1 AND enabled=1 LIMIT 1", [creatorId]);
    if (!cfg.rows.length) return res.status(404).json({ success: false, error: "AD_REVENUE_NOT_ENABLED" });

    const recent = await query("SELECT COUNT(*) AS c FROM ad_revenue_clicks WHERE creator_id=$1 AND created_at > datetime('now','-1 day')", [creatorId]);
    const total = Number(recent.rows[0].c || 0);
    const counts = (total % 10) < 7;
    await run("INSERT INTO ad_revenue_clicks (id, creator_id, visitor_id, counted) VALUES ($1, $2, $3, $4)", [uuidv4(), creatorId, req.user.id, counts ? 1 : 0]);

    if (counts) {
      const payout = Number(process.env.REWARDED_AD_CREATOR_PAYOUT_NGN || 5);
      await ensureWallet(creatorId);
      await run("UPDATE wallets SET balance_ngn = balance_ngn + $1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2", [payout, creatorId]);
      await run("INSERT INTO wallet_transactions (id, user_id, amount_ngn, type, reference, description) VALUES ($1, $2, $3, 'ad_revenue', $4, $5)", [uuidv4(), creatorId, payout, "adrev-" + uuidv4(), "Rewarded ad view from visitor"]);
    }

    res.json({ success: true, counted: counts });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/ad-revenue/earnings", monetizationAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const total = await query("SELECT COALESCE(SUM(amount_ngn),0) AS total FROM wallet_transactions WHERE user_id=$1 AND type='ad_revenue'", [req.user.id]);
    const clicks = await query("SELECT COUNT(*) AS c FROM ad_revenue_clicks WHERE creator_id=$1 AND counted=1", [req.user.id]);
    res.json({ success: true, total_earned_ngn: Number(total.rows[0].total || 0), counted_views: Number(clicks.rows[0].c || 0) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/invite/criteria", monetizationAuth(), async (req, res) => {
  try {
    const result = await checkCriteria(req.user.id, "invite");
    res.json({ success: true, met: result.ok, criteria: result.criteria });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/invite/enable", monetizationAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const uid = req.user.id;
    const result = await checkCriteria(uid, "invite");
    if (!result.ok) return res.status(403).json({ success: false, error: "CRITERIA_NOT_MET", criteria: result.criteria });

    let code = await query("SELECT code FROM referral_codes WHERE user_id=$1 LIMIT 1", [uid]);
    if (!code.rows.length) {
      let newCode = generateReferralCode();
      let tries = 0;
      while (tries < 5) {
        const clash = await query("SELECT 1 FROM referral_codes WHERE code=$1 LIMIT 1", [newCode]);
        if (!clash.rows.length) break;
        newCode = generateReferralCode();
        tries++;
      }
      await run("INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)", [uid, newCode]);
      code = { rows: [{ code: newCode }] };
    }

    await run("INSERT INTO monetization_choice (user_id, active_method, enabled_at) VALUES ($1, 'invite', CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET active_method='invite', enabled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP", [uid]);
    await ensureWallet(uid);

    res.json({ success: true, code: code.rows[0].code });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/invite/cancel", monetizationAuth(), async (req, res) => {
  try {
    const { run } = require("./src/db");
    await run("UPDATE monetization_choice SET active_method=NULL, updated_at=CURRENT_TIMESTAMP WHERE user_id=$1", [req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/invite/me", monetizationAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const uid = req.user.id;
    const code = await query("SELECT code FROM referral_codes WHERE user_id=$1 LIMIT 1", [uid]);
    const progress = await query("SELECT p.*, u.first_name, u.surname, u.username FROM referral_progress p JOIN users u ON u.id = p.invitee_id WHERE p.inviter_id=$1 ORDER BY p.created_at DESC LIMIT 100", [uid]);
    const total = await query("SELECT COALESCE(SUM(amount_ngn),0) AS total FROM wallet_transactions WHERE user_id=$1 AND type='invite_reward'", [uid]);
    res.json({ success: true, code: code.rows[0]?.code || null, invitees: progress.rows, total_earned_ngn: Number(total.rows[0].total || 0) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/invite/apply", monetizationAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const code = String(req.body.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, error: "CODE_REQUIRED" });

    const owner = await query("SELECT user_id FROM referral_codes WHERE code=$1 LIMIT 1", [code]);
    if (!owner.rows.length) return res.status(404).json({ success: false, error: "INVALID_CODE" });
    const inviterId = owner.rows[0].user_id;
    if (inviterId === req.user.id) return res.status(400).json({ success: false, error: "CANNOT_USE_OWN_CODE" });

    const existing = await query("SELECT 1 FROM referral_progress WHERE invitee_id=$1 LIMIT 1", [req.user.id]);
    if (existing.rows.length) return res.status(400).json({ success: false, error: "ALREADY_APPLIED" });

    await run("INSERT INTO referral_progress (id, inviter_id, invitee_id, stage) VALUES ($1, $2, $3, 'signed_up')", [uuidv4(), inviterId, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/v1/wallet/banks", monetizationAuth(), async (req, res) => {
  try {
    const squad = require("./src/providers/squad");
    const banks = await squad.getBanks();
    res.json({ success: true, banks });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/wallet/lookup", monetizationAuth(), async (req, res) => {
  try {
    const squad = require("./src/providers/squad");
    const bankCode = String(req.body.bank_code || "");
    const accountNumber = String(req.body.account_number || "");
    if (!bankCode || !accountNumber) return res.status(400).json({ success: false, error: "BANK_AND_ACCOUNT_REQUIRED" });
    const info = await squad.lookupAccount(bankCode, accountNumber);
    res.json({ success: true, account_name: info.account_name });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/wallet/withdraw", monetizationAuth(), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const uid = req.user.id;
    const wallet = await ensureWallet(uid);
    const balance = Number(wallet.balance_ngn || 0);
    const threshold = Number(wallet.threshold_ngn || 7500);
    if (balance < threshold) return res.status(400).json({ success: false, error: "BELOW_THRESHOLD", balance, threshold });

    const bankCode = String(req.body.bank_code || "");
    const accountNumber = String(req.body.account_number || "");
    const accountName = String(req.body.account_name || "");
    if (!bankCode || !accountNumber || !accountName) return res.status(400).json({ success: false, error: "MISSING_FIELDS" });

    const amount = Number(req.body.amount_ngn || balance);
    if (amount > balance) return res.status(400).json({ success: false, error: "INSUFFICIENT_BALANCE" });

    const ref = "connecto-wd-" + uuidv4();
    await run("INSERT INTO withdrawal_requests (id, user_id, amount_ngn, bank_code, account_number, account_name, squad_reference, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing')", [uuidv4(), uid, amount, bankCode, accountNumber, accountName, ref]);

    await run("UPDATE wallets SET balance_ngn = balance_ngn - $1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2", [amount, uid]);
    await run("INSERT INTO wallet_transactions (id, user_id, amount_ngn, type, reference, description) VALUES ($1, $2, $3, 'withdrawal', $4, $5)", [uuidv4(), uid, -amount, ref, "Withdrawal to " + accountName]);

    try {
      const squad = require("./src/providers/squad");
      await squad.transfer({
        bankCode,
        accountNumber,
        accountName,
        amountKobo: amount * 100,
        reference: ref,
        narration: "Connecto wallet withdrawal"
      });
    } catch (e) {
      console.error("[WITHDRAW-TRANSFER]", e.message);
    }

    res.json({ success: true, reference: ref, amount_ngn: amount });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/v1/payments/webhook", express.json({ type: "*/*" }), async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const body = req.body || {};
    const reference = String(body.transaction_ref || body.reference || "");
    const status = String(body.transaction_status || body.status || "").toLowerCase();
    const eventType = String(body.event || body.Event || "");

    if (!reference) return res.status(200).json({ success: true });

    if (status === "success" || eventType.toLowerCase() === "charge.successful") {
      const sup = await query("SELECT * FROM stars_supporters WHERE squad_reference=$1 LIMIT 1", [reference]);
      if (sup.rows.length && sup.rows[0].status !== "paid") {
        const row = sup.rows[0];
        await run("UPDATE stars_supporters SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=$1", [row.id]);
        await ensureWallet(row.creator_id);
        await run("UPDATE wallets SET balance_ngn = balance_ngn + $1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2", [row.creator_share_ngn, row.creator_id]);
        await run("INSERT INTO wallet_transactions (id, user_id, amount_ngn, type, reference, description) VALUES ($1, $2, $3, 'star_support', $4, $5)", [uuidv4(), row.creator_id, row.creator_share_ngn, reference, "Star support received"]);
      }
    }
    res.status(200).json({ success: true });
  } catch (e) {
    console.error("[PAYMENT-WEBHOOK]", e.message);
    res.status(200).json({ success: true });
  }
});

app.get("/api/v1/payments/status/:ref", monetizationAuth(), async (req, res) => {
  try {
    const { query } = require("./src/db");
    const r = await query("SELECT status, creator_share_ngn, amount_ngn FROM stars_supporters WHERE squad_reference=$1 LIMIT 1", [req.params.ref]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    res.json({ success: true, status: r.rows[0].status, amount_ngn: r.rows[0].amount_ngn, creator_share_ngn: r.rows[0].creator_share_ngn });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* [/MONETIZATION] */

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: monetization patch applied to server.js");
