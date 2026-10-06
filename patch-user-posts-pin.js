const fs = require("fs");
const path = "src/routes/complete-v1.js";

if (!fs.existsSync(path)) {
  console.error("ERROR: " + path + " not found");
  process.exit(1);
}

let cv = fs.readFileSync(path, "utf8");

if (cv.includes("[USER-POSTS-PIN]")) {
  console.log("SKIP: already patched");
  process.exit(0);
}

const oldFragment = "COALESCE(p.view_count, 0) AS view_count,\n              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key,";

const newFragment = "COALESCE(p.view_count, 0) AS view_count,\n              (u.pinned_post_id = p.id) AS pinned,\n              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key,";

if (!cv.includes(oldFragment)) {
  console.log("MATCH NOT FOUND. Searching for view_count fragment...");
  const idx = cv.indexOf("COALESCE(p.view_count, 0) AS view_count");
  if (idx !== -1) {
    console.log("Found at index " + idx + ". Context:");
    console.log(JSON.stringify(cv.slice(idx, idx + 400)));
  } else {
    console.log("view_count fragment not found at all");
  }
  process.exit(1);
}

cv = cv.replace(oldFragment, newFragment);
fs.writeFileSync(path, cv);
console.log("OK: pinned flag added to profile posts query");
