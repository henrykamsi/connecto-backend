const express = require("express");
const { z } = require("zod");

const { query } = require("../db");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.post("/", authenticate, async (req, res, next) => {
  try {
    const schema = z.object({
      text: z.string().max(10000).optional(),
      audience: z.enum(["Everyone", "Followers", "Friends"]).default("Everyone"),
      comments_enabled: z.boolean().default(true),
      like_count_visible: z.boolean().default(true)
    });

    const data = schema.parse(req.body);

    if (!data.text) {
      return res.status(422).json({
        success: false,
        error: "POST_CONTENT_REQUIRED"
      });
    }

    const result = await query(
      `INSERT INTO posts
       (author_id,text,audience,comments_enabled,like_count_visible)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        req.user.id,
        data.text,
        data.audience,
        data.comments_enabled,
        data.like_count_visible
      ]
    );

    res.status(201).json({
      success: true,
      post: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit || 20), 1),
      50
    );

    const offset = Math.max(Number(req.query.offset || 0), 0);

    const result = await query(
      `SELECT
        p.id,
        p.author_id,
        p.text,
        p.audience,
        p.created_at,
        u.name,
        u.surname,
        u.username,
        u.profile_photo_url
       FROM posts p
       JOIN users u ON u.id=p.author_id
       WHERE p.deleted_at IS NULL
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      success: true,
      posts: result.rows,
      pagination: {
        limit,
        offset,
        returned: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:postId", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.*,u.name,u.surname,u.username,u.profile_photo_url
       FROM posts p
       JOIN users u ON u.id=p.author_id
       WHERE p.id=$1 AND p.deleted_at IS NULL`,
      [req.params.postId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "POST_NOT_FOUND"
      });
    }

    res.json({
      success: true,
      post: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:postId", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE posts
       SET deleted_at=NOW()
       WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.postId, req.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "POST_NOT_FOUND_OR_NOT_OWNER"
      });
    }

    res.json({
      success: true,
      deleted: true
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
