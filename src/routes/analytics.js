const express = require("express");
const router = express.Router();
const { query } = require("../db");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    const p = jwt.verify(h.slice(7), env.jwt.secret);
    req.userId = p.sub;
    next();
  } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
}

router.get("/visitors", auth, async (req, res) => {
  try {
    // Check if paid
    const paid = await query("SELECT * FROM shop_purchases WHERE user_id=$1 AND item_id='analytics' AND expires_at > CURRENT_TIMESTAMP LIMIT 1", [req.userId]);
    const isPaid = paid.rows.length > 0;

    // Check if ad-unlocked (max 30 viewers)
    const adUnlocked = await query("SELECT * FROM shop_purchases WHERE user_id=$1 AND item_id='analytics_ad' AND expires_at > CURRENT_TIMESTAMP LIMIT 1", [req.userId]);
    const hasAdUnlock = adUnlocked.rows.length > 0;

    if (!isPaid && !hasAdUnlock) {
      return res.json({ success: true, isPaid: false, visitors: [] });
    }

    let sql = "SELECT pv.created_at AS time, u.first_name, u.surname, u.username, u.profile_photo_media_id, u.country, u.gender FROM profile_views pv JOIN users u ON u.id = pv.viewer_id WHERE pv.user_id=$1 ORDER BY pv.created_at DESC";
    let limit = isPaid ? 100 : 30;

    const r = await query(sql + " LIMIT $2", [req.userId, limit]);

    const visitors = r.rows.map(v => {
      if (isPaid) return v;
      return { first_name: v.first_name, surname: v.surname, username: v.username, profile_photo_media_id: v.profile_photo_media_id };
    });

    res.json({ success: true, isPaid: isPaid, visitors: visitors });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
