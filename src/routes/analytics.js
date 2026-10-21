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
    // Check if user has premium analytics or ad-unlock
    const purchase = await query("SELECT * FROM shop_purchases WHERE user_id=$1 AND item_id='analytics' AND expires_at > CURRENT_TIMESTAMP ORDER BY expires_at DESC LIMIT 1", [req.userId]);
    const isPaid = purchase.rows.length > 0;

    let sql = "SELECT pv.*, u.first_name, u.surname, u.username, u.profile_photo_media_id, u.country, u.gender FROM profile_views pv JOIN users u ON u.id = pv.viewer_id WHERE pv.user_id=$1 ORDER BY pv.created_at DESC";
    let limit = 50;

    if (!isPaid) {
      // If not paid, check if they have ad-unlock (we just limit to 30 and strip data)
      limit = 30;
    }

    sql += " LIMIT $2";
    const r = await query(sql, [req.userId, limit]);

    const visitors = r.rows.map(v => {
      if (isPaid) {
        return v; // Return everything
      } else {
        // Strip timestamp, country, gender for AD users
        return {
          first_name: v.first_name,
          surname: v.surname,
          username: v.username,
          profile_photo_media_id: v.profile_photo_media_id
        };
      }
    });

    res.json({ success: true, isPaid, visitors });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
