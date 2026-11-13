const fs = require("fs");
const { execSync } = require("child_process");

const sfPath = "src/routes/smart-feed.js";
let sf = fs.readFileSync(sfPath, "utf8");

// Find the POST_COLS string that lists all the columns
const anchor = 'p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.share_enabled, p.created_at,';

if (sf.includes(anchor)) {
  if (!sf.includes("p.warning_label")) {
    sf = sf.replace(anchor, anchor + " p.warning_label, p.warning_label_style,");
    fs.writeFileSync(sfPath, sf);
    console.log("[1] Added warning_label to smart-feed query");
  } else {
    console.log("[1] warning_label already in smart-feed query");
  }
} else {
  console.log("[1] Could not find POST_COLS in smart-feed.js");
}

// Now do the same for the single post fetch in server.js / complete-v1.js
let src = fs.readFileSync("server.js", "utf8");
const fetchAnchor = /SELECT p\.\*,( u\.first_name|u\.name)/;
// Actually, the fetch probably uses p.* so it should be fine, or it's in complete-v1.js.
let cv = fs.readFileSync("src/routes/complete-v1.js", "utf8");
const cvAnchor = 'p.created_at, p.updated_at, p.deleted_at,';
if (cv.includes(cvAnchor) && !cv.includes("p.warning_label")) {
  cv = cv.replace(cvAnchor, cvAnchor + " p.warning_label, p.warning_label_style,");
  fs.writeFileSync("src/routes/complete-v1.js", cv);
  console.log("[2] Added warning_label to complete-v1.js query");
}

try {
  execSync("node --check " + sfPath, { stdio: "pipe" });
  execSync("node --check src/routes/complete-v1.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
