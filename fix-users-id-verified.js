const fs = require("fs");
const path = "src/routes/complete-v1.js";

let cv = fs.readFileSync(path, "utf8");

// Look at all files that might define /users/:id — the app routes to complete-v1.js
// but the route might be defined elsewhere. Search for the one that returns account_status.

const badSelect = `SELECT id, first_name, surname, email, username, bio, category,
              country, state, gender,
              profile_photo_media_id, cover_photo_media_id,
              account_status
       FROM users WHERE id=$1 LIMIT 1`;

const goodSelect = `SELECT id, first_name, surname, email, username, bio, category,
              country, state, gender,
              profile_photo_media_id, cover_photo_media_id,
              is_verified, is_owner, email_verified, account_status
       FROM users WHERE id=$1 LIMIT 1`;

let changes = 0;

if (cv.includes(badSelect)) {
  cv = cv.replace(badSelect, goodSelect);
  changes++;
}

// Also try the pattern where fields are on one line with a preceding quote
const badSelect2 = "SELECT id, first_name, surname, email, username, bio, category, country, state, gender, profile_photo_media_id, cover_photo_media_id, account_status";
const goodSelect2 = "SELECT id, first_name, surname, email, username, bio, category, country, state, gender, profile_photo_media_id, cover_photo_media_id, is_verified, is_owner, email_verified, account_status";

if (cv.includes(badSelect2)) {
  cv = cv.replace(badSelect2, goodSelect2);
  changes++;
}

if (changes === 0) {
  console.log("NO MATCH — showing all /users/:id blocks:");
  const lines = cv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("router.get('/users/:id'") || lines[i].includes('router.get("/users/:id"')) {
      console.log("Line " + (i+1) + ": " + lines[i]);
      for (let j = i+1; j < i+25 && j < lines.length; j++) {
        console.log("  " + lines[j]);
      }
      console.log("---");
    }
  }
  process.exit(1);
}

fs.writeFileSync(path, cv);
console.log("OK: added is_verified to " + changes + " /users/:id query");
