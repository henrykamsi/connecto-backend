const fs = require("fs");
const path = "src/routes/complete-v1.js";

if (!fs.existsSync(path)) {
  console.error("ERROR: src/routes/complete-v1.js not found");
  process.exit(1);
}

let cv = fs.readFileSync(path, "utf8");

const brokenBlock = `SELECT id, name, surname, email, username, first_name,`;
const fixedBlock   = `SELECT id, first_name, surname, email, username,`;

if (!cv.includes(brokenBlock)) {
  console.log("NO MATCH — searching for 'name,' inside /auth/me...");
  const idx = cv.indexOf("router.get('/auth/me'");
  if (idx !== -1) {
    console.log(cv.slice(idx, idx + 700));
  } else {
    console.log("Could not find /auth/me in file.");
  }
  process.exit(1);
}

cv = cv.replace(brokenBlock, fixedBlock);
fs.writeFileSync(path, cv);
console.log("OK: removed bad 'name' column from /auth/me");
