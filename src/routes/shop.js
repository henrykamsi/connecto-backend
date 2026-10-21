const express = require("express");
const router = express.Router();
const { query, run } = require("../db");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { v4: uuidv4 } = require("uuid");

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    const p = jwt.verify(h.slice(7), env.jwt.secret);
    req.userId = p.sub;
    next();
  } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
}

// List active shop items
router.get("/items", async (req, res) => {
  try {
    // For now, return static list. Later can be from DB.
    res.json({
      success: true,
      items: [
        { id: "glow", name: "Animated Profile Glow", price_1w: 300, price_1m: 1000, price_1y: 4500, ad_unlock: "1 Day" },
        { id: "boost", name: "Boost Boost (Post)", price_1d: 1500, ad_unlock: null },
        { id: "analytics", name: "Profile Visitors", price_1m: 1100, price_5m: 3600, price_1y: 5500, ad_unlock: "4 Ads for 30 Viewers" },
        { id: "paid_check", name: "Paid Blue Checkmark", price_1m: 3500, price_1y: 15500, ad_unlock: null },
        { id: "org", name: "Create Organization", price_1m: 6500, price_1y: 25500, ad_unlock: null }
      ]
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Purchase an item
router.post("/purchase", auth, async (req, res) => {
  try {
    const { itemId, duration } = req.body;
    if (!itemId || !duration) return res.status(400).json({ success: false, error: "MISSING_FIELDS" });

    // In a real app, you would call Squad API here to generate a checkout URL.
    // For now, we simulate a successful purchase and log it.
    const expiresAt = new Date();
    if (duration === "1d") expiresAt.setDate(expiresAt.getDate() + 1);
    else if (duration === "1w") expiresAt.setDate(expiresAt.getDate() + 7);
    else if (duration === "1m") expiresAt.setMonth(expiresAt.getMonth() + 1);
    else if (duration === "5m") expiresAt.setMonth(expiresAt.getMonth() + 5);
    else if (duration === "1y") expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await run("INSERT INTO shop_purchases (id, user_id, item_id, duration, expires_at) VALUES ($1,$2,$3,$4,$5)", 
      [uuidv4(), req.userId, itemId, duration, expiresAt.toISOString()]);

    res.json({ success: true, message: "Purchase successful (Simulated)", checkout_url: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Unlock via Ads
router.post("/ad-unlock", auth, async (req, res) => {
  try {
    const { itemId } = req.body;
    if (itemId === "analytics") {
      // Logic for 4 ads -> 30 viewers limit goes here
      res.json({ success: true, message: "Ad unlock active: Max 30 viewers." });
    } else if (itemId === "glow") {
      res.json({ success: true, message: "Glow unlocked for 1 Day." });
    } else {
      res.status(400).json({ success: false, error: "NOT_AVAILABLE_VIA_AD" });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
