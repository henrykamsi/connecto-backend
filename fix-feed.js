const fs = require("fs");
const path = "src/routes/complete-v1.js";

let s = fs.readFileSync(path, "utf8");

const newFragment = "WHERE (f.user_a_id=$1 AND f.user_b_id=p.author_id) OR (f.user_b_id=$1 AND f.user_a_id=p.author_id)";

if (s.includes(newFragment)) {
  console.log("ALREADY PATCHED");
  process.exit(0);
}

const oldFragment = "WHERE f.user_id=$1 AND f.friend_id=p.author_id";

if (s.includes(oldFragment)) {
  s = s.replace(oldFragment, newFragment);
  fs.writeFileSync(path, s);
  console.log("PATCHED");
  process.exit(0);
}

const alt = "f.user_id=$1 AND f.friend_id=p.author_id";

if (s.includes(alt)) {
  s = s.replace(alt, "(f.user_a_id=$1 AND f.user_b_id=p.author_id) OR (f.user_b_id=$1 AND f.user_a_id=p.author_id)");
  fs.writeFileSync(path, s);
  console.log("PATCHED (alternate)");
  process.exit(0);
}

console.log("NO MATCH FOUND");
console.log("Showing lines 665-685 for debugging:");
const lines = s.split("\n");
for (let i = 664; i < 685 && i < lines.length; i++) {
  console.log((i + 1) + ": " + lines[i]);
}
process.exit(1);
