const express = require("express");
const { authenticate } = require("../middleware/auth");
const { query } = require("../db");

const router = express.Router();

router.get("/", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT *
       FROM notifications
       WHERE recipient_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/read", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE notifications
       SET read_at=NOW()
       WHERE id=$1 AND recipient_id=$2
       RETURNING id,read_at`,
      [req.params.id, req.user.id]
    );

    res.json({
      success: true,
      notification: result.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
