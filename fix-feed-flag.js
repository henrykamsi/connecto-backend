const fs = require("fs");
const path = "src/routes/complete-v1.js";

let cv = fs.readFileSync(path, "utf8");

const old = "'u.first_name, u.surname, u.username, u.profile_photo_media_id, ' +";
const neu = "'u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified AS author_verified, ' +";

if (!cv.includes(old)) {
  console.log("NO MATCH — feed already patched or text differs");
  process.exit(1);
}

cv = cv.replace(old, neu);
fs.writeFileSync(path, cv);
console.log("OK: feed now sends author_verified");
