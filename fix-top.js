const fs = require("fs");
const path = "src/routes/complete-v1.js";

let cv = fs.readFileSync(path, "utf8");

if (cv.includes("[TOP-FIX]")) {
  console.log("SKIP: already present");
  process.exit(0);
}

const anchor = "const router = express.Router();";
if (!cv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `${anchor}

/* [TOP-FIX] Override /users/:id and /posts/:id/comments at the very top
   so they beat any previously-defined routes. */

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
    if (!r.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
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
`;

cv = cv.replace(anchor, block);
fs.writeFileSync(path, cv);
console.log("OK: routes added at top of router");
