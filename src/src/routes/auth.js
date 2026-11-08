const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const { query } = require("../db");
const config = require("../config/env");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128)
});

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email
    },
    config.jwt.secret,
    {
      expiresIn: config.jwt.expiresIn
    }
  );
}

router.post("/register", async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);

    const existing = await query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [input.email]
    );

    if (existing.rowCount) {
      return res.status(409).json({
        success: false,
        error: "EMAIL_ALREADY_EXISTS"
      });
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const result = await query(
      `INSERT INTO users
       (name, surname, email, password_hash)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, surname, email, username, created_at`,
      [
        input.name,
        input.surname,
        input.email,
        passwordHash
      ]
    );

    const user = result.rows[0];

    res.status(201).json({
      success: true,
      user,
      token: signToken(user)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await query(
      `SELECT id,name,surname,email,username,password_hash
       FROM users
       WHERE LOWER(email)=LOWER($1)
       AND deleted_at IS NULL`,
      [email]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        success: false,
        error: "INVALID_CREDENTIALS"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        success: false,
        error: "INVALID_CREDENTIALS"
      });
    }

    delete user.password_hash;

    res.json({
      success: true,
      user,
      token: signToken(user)
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id,name,surname,email,username,bio,category,
              country,state,gender,profile_photo_url,cover_photo_url,
              created_at
       FROM users
       WHERE id=$1 AND deleted_at IS NULL`,
      [req.user.id]
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

router.post("/logout", authenticate, async (req, res) => {
  res.json({
    success: true,
    message: "Logout acknowledged. Client should discard its access token."
  });
});

module.exports = router;
