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

// RECORD A PROFILE VIEW (Called when someone opens your profile)
router.post("/view/:targetId", auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    if (targetId === req.userId) return res.json({ success: true }); // Don't record self-views

    await run("INSERT INTO profile_views (id, user_id, viewer_id) VALUES ($1, $2, $3)", [uuidv4(), targetId, req.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET VISITORS (For the Profile Visitors screen)
router.get("/visitors", auth, async (req, res) => {
  try {
    // Check if paid
    const paid = await query("SELECT 1 FROM shop_purchases WHERE user_id=$1 AND item_id='analytics' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) LIMIT 1", [req.userId]);
    const isPaid = paid.rows.length > 0;

    // Check if ad-unlocked
    const adUnlocked = await query("SELECT 1 FROM shop_purchases WHERE user_id=$1 AND item_id='analytics_ad' AND expires_at > CURRENT_TIMESTAMP LIMIT 1", [req.userId]);
    const hasAdUnlock = adUnlocked.rows.length > 0;

    if (!isPaid && !hasAdUnlock) {
      return res.json({ success: true, isPaid: false, visitors: [] });
    }

    const limit = isPaid ? 100 : 30;
    const r = await query(
      "SELECT pv.created_at AS time, u.first_name, u.surname, u.username, u.profile_photo_media_id, u.country, u.gender FROM profile_views pv JOIN users u ON u.id = pv.viewer_id WHERE pv.user_id=$1 ORDER BY pv.created_at DESC LIMIT $2",
      [req.userId, limit]
    );

    const visitors = r.rows.map(v => {
      if (isPaid) return v;
      // If ad unlocked, hide country/gender
      return { first_name: v.first_name, surname: v.surname, username: v.username, profile_photo_media_id: v.profile_photo_media_id, time: v.time };
    });

    res.json({ success: true, isPaid: isPaid, visitors: visitors });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
