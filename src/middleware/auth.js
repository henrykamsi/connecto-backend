const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query } = require('../db');

async function auth(req,res,next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        success:false,
        error:'Authentication required'
      });
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, env.jwtSecret);

    const result = await query(
      `SELECT id,name,surname,email,username,bio,category,country,state,gender,
              profile_photo_url,cover_photo_url,account_status
       FROM users WHERE id=$1`,
      [payload.sub]
    );

    if (!result.rows.length) {
      return res.status(401).json({success:false,error:'User not found'});
    }

    if (result.rows[0].account_status &&
        result.rows[0].account_status !== 'active') {
      return res.status(403).json({
        success:false,
        error:'Account unavailable'
      });
    }

    req.user = result.rows[0];
    req.auth = payload;

    next();
  } catch (err) {
    return res.status(401).json({
      success:false,
      error:'Invalid or expired token'
    });
  }
}

module.exports = auth;
