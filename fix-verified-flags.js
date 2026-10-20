const fs = require("fs");
const path = "src/routes/complete-v1.js";

if (!fs.existsSync(path)) {
  console.error("ERROR: src/routes/complete-v1.js not found");
  process.exit(1);
}

let cv = fs.readFileSync(path, "utf8");

// 1. FEED: add u.is_verified AS author_verified to the SELECT
if (!cv.includes("u.is_verified AS author_verified")) {
  // find the feed query and add the column right after u.profile_photo_media_id
  cv = cv.replace(
    /u\.profile_photo_media_id\s*,?\s*\n\s*COALESCE\(rc\.reaction_count/g,
    "u.profile_photo_media_id,\n         u.is_verified AS author_verified,\n         COALESCE(rc.reaction_count"
  );
}

// 2. SINGLE POST: add the column
if (!cv.includes("u.is_verified AS author_verified")) {
  // fallback: try another pattern
  cv = cv.replace(
    /u\.first_name,u\.surname,u\.username,u\.profile_photo_media_id/g,
    "u.first_name,u.surname,u.username,u.profile_photo_media_id,u.is_verified AS author_verified"
  );
}

// 3. COMMENTS: add the column
cv = cv.replace(
  /u\.first_name,u\.surname,u\.username,u\.profile_photo_media_id\s*\n\s*FROM comments m/g,
  "u.first_name,u.surname,u.username,u.profile_photo_media_id,u.is_verified AS author_verified\n       FROM comments m"
);

// 4. USER POSTS: add the column
cv = cv.replace(
  /u\.first_name,\s*u\.surname,\s*u\.username,\s*u\.profile_photo_media_id,\s*\n\s*COALESCE\(p\.view_count/g,
  "u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified AS author_verified,\n              COALESCE(p.view_count"
);

fs.writeFileSync(path, cv);
console.log("OK: verified flags added where possible");
