const fs = require("fs");
const path = "src/routes/complete-v1.js";

let cv = fs.readFileSync(path, "utf8");

if (cv.includes("[MISSING-ENDPOINTS]")) {
  console.log("SKIP: already added");
  process.exit(0);
}

// Find a spot to insert — right before module.exports = router
const anchor = "module.exports = router;";
if (!cv.includes(anchor)) {
  console.error("ERROR: anchor 'module.exports = router;' not found");
  process.exit(1);
}

const block = `/* [MISSING-ENDPOINTS] Single user + comments list */

router.get('/users/:id',auth,async(req,res)=>{
  try {
    const r = await query(
      \`SELECT id, first_name, surname, email, username, bio, category,
              country, state, gender,
              profile_photo_media_id, cover_photo_media_id,
              is_verified, is_owner, email_verified
       FROM users WHERE id=$1 LIMIT 1\`,
      [req.params.id]
    );
    if (!r.rows.length) {
      return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    }
    res.json({ success: true, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/posts/:id/comments',auth,async(req,res)=>{
  try {
    const r = await query(
      \`SELECT c.id, c.body, c.author_id, c.parent_comment_id, c.created_at,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              u.is_verified AS author_verified
       FROM comments c
       JOIN users u ON u.id = c.author_id
       WHERE c.post_id=$1 AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC
       LIMIT 200\`,
      [req.params.id]
    );
    res.json({ success: true, comments: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/me/bookmarks',auth,async(req,res)=>{
  try {
    const r = await query(
      \`SELECT p.id, p.text, p.author_id, p.created_at,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              u.is_verified AS author_verified
       FROM bookmarks b
       JOIN posts p ON p.id = b.post_id
       JOIN users u ON u.id = p.author_id
       WHERE b.user_id=$1 AND p.deleted_at IS NULL
       ORDER BY b.created_at DESC LIMIT 100\`,
      [req.user.id]
    );
    res.json({ success: true, posts: r.rows });
  } catch (e) {
    res.json({ success: true, posts: [] });
  }
});

`;

cv = cv.replace(anchor, block + anchor);
fs.writeFileSync(path, cv);
console.log("OK: added /users/:id, /posts/:id/comments, /me/bookmarks");
