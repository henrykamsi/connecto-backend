const express = require("express");
const router = express.Router();
const { query, run } = require("../db");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { v4: uuidv4 } = require("uuid");
const squad = require("../providers/squad");

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    const p = jwt.verify(h.slice(7), env.jwt.secret);
    req.userId = p.sub;
    next();
  } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
}

router.get("/items", async (req, res) => {
  res.json({
    success: true,
    items: [
      { id: "glow", name: "Animated Profile Glow", price_1w: 300, price_1m: 1000, price_1y: 4500, ad_unlock: "1 Day" },
      { id: "boost", name: "Boost Boost (Post)", price_1d: 1500 },
      { id: "analytics", name: "Profile Visitors", price_1m: 1100, price_5m: 3600, price_1y: 5500, ad_unlock: "4 Ads for 30 Viewers" },
      { id: "paid_check", name: "Paid Blue Checkmark", price_1m: 3500, price_1y: 15500 },
      { id: "org", name: "Create Organization", price_1m: 6500, price_1y: 25500 }
    ]
  });
});

router.post("/purchase", auth, async (req, res) => {
  try {
    const { itemId, duration } = req.body;
    if (!itemId || !duration) return res.status(400).json({ success: false, error: "MISSING_FIELDS" });

    const prices = {
      glow: { "1w": 300, "1m": 1000, "1y": 4500 },
      boost: { "1d": 1500 },
      analytics: { "1m": 1100, "5m": 3600, "1y": 5500 },
      paid_check: { "1m": 3500, "1y": 15500 },
      org: { "1m": 6500, "1y": 25500 }
    };

    const amount = prices[itemId]?.[duration];
    if (!amount) return res.status(400).json({ success: false, error: "INVALID_PRICING" });

    const u = await query("SELECT email FROM users WHERE id=$1", [req.userId]);
    const email = u.rows[0]?.email || "user@connecto.app";
    const reference = "connecto-" + itemId + "-" + uuidv4();

    let checkoutUrl = null;
    try {
      checkoutUrl = await squad.initTransaction({
        email: email,
        amountKobo: amount * 100,
        reference: reference,
        callbackUrl: "connecto://payment-return?ref=" + reference
      });
    } catch (e) {
      console.error("[SHOP-SQUAD]", e.message);
    }

    // Save a PENDING purchase
    await run("INSERT INTO shop_purchases (id, user_id, item_id, duration, reference) VALUES ($1,$2,$3,$4,$5)",
      [uuidv4(), req.userId, itemId, duration, reference]);

    res.json({ success: true, checkout_url: checkoutUrl, reference });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// AD UNLOCK FIX: Actually grants the feature
router.post("/ad-unlock", auth, async (req, res) => {
  try {
    const { itemId } = req.body;
    const now = new Date();
    
    if (itemId === "analytics") {
      const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 1 Day
      await run("INSERT INTO shop_purchases (id, user_id, item_id, duration, expires_at) VALUES ($1,$2,$3,'ad',$4)",
        [uuidv4(), req.userId, "analytics_ad", expires]);
      res.json({ success: true, message: "Ad unlock active: Max 30 viewers for 24 hours." });
    } else if (itemId === "glow") {
      const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 1 Day
      await run("INSERT INTO shop_purchases (id, user_id, item_id, duration, expires_at) VALUES ($1,$2,$3,'ad',$4)",
        [uuidv4(), req.userId, "glow_ad", expires]);
      res.json({ success: true, message: "Glow unlocked for 1 Day." });
    } else {
      res.status(400).json({ success: false, error: "NOT_AVAILABLE_VIA_AD" });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
