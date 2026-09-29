const express = require("express");
const { z } = require("zod");

const { query } = require("../db");
const { authenticate } = require("../middleware/auth");
const { createNotification } = require("../services/notifications");

const router = express.Router();

router.get("/:userId", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id,name,surname,username,bio,category,country,state,
              gender,profile_photo_url,cover_photo_url,created_at
       FROM users
       WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "USER_NOT_FOUND"
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.put("/me/profile", authenticate, async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      surname: z.string().trim().min(1).max(100).optional(),
      bio: z.string().max(1000).optional(),
      category: z.string().max(100).optional(),
      country: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      gender: z.enum(["Male", "Female", "Rather not say"]).optional()
    });

    const data = schema.parse(req.body);

    const result = await query(
      `UPDATE users SET
       name=COALESCE($1,name),
       surname=COALESCE($2,surname),
       bio=COALESCE($3,bio),
       category=COALESCE($4,category),
       country=COALESCE($5,country),
       state=COALESCE($6,state),
       gender=COALESCE($7,gender),
       updated_at=NOW()
       WHERE id=$8
       RETURNING id,name,surname,email,username,bio,category,country,state,gender`,
      [
        data.name ?? null,
        data.surname ?? null,
        data.bio ?? null,
        data.category ?? null,
        data.country ?? null,
        data.state ?? null,
        data.gender ?? null,
        req.user.id
      ]
    );

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:userId/follow", authenticate, async (req, res, next) => {
  try {
    const targetId = req.params.userId;

    if (targetId === req.user.id) {
      return res.status(400).json({
        success: false,
        error: "CANNOT_FOLLOW_SELF"
      });
    }

    await query(
      `INSERT INTO follows (follower_id, following_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, targetId]
    );

    await createNotification({
      recipientId: targetId,
      actorId: req.user.id,
      type: "USER_FOLLOWED",
      title: "New follower",
      body: "Someone followed you.",
      targetType: "profile",
      targetId: req.user.id
    });

    res.status(201).json({
      success: true,
      following: true
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:userId/follow", authenticate, async (req, res, next) => {
  try {
    await query(
      `DELETE FROM follows
       WHERE follower_id=$1 AND following_id=$2`,
      [req.user.id, req.params.userId]
    );

    res.json({
      success: true,
      following: false
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
