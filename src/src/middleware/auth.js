const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { query } = require("../db");

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, env.jwt.secret);

    const result = await query(
      `SELECT
         id,
         email,
         mobile,
         username,
         first_name,
         surname,
         bio,
         category,
         country,
         state,
         gender,
         profile_photo_media_id,
         cover_photo_media_id,
         account_status
       FROM users
       WHERE id=$1
       LIMIT 1`,
      [payload.sub]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        error: "User not found"
      });
    }

    const user = result.rows[0];

    if (user.account_status && user.account_status !== "active") {
      return res.status(403).json({
        success: false,
        error: "Account is not active"
      });
    }

    req.user = user;
    req.auth = payload;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token"
    });
  }
}

module.exports = auth;
module.exports.authenticate = auth;
