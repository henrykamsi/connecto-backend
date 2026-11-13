const fs = require("fs");
const { execSync } = require("child_process");

// 1) Kill the broken handler in complete-v1.js
let cv = fs.readFileSync("src/routes/complete-v1.js", "utf8");
const brokenRe = /router\.post\(\s*['"]\/chat\/conversations['"][\s\S]*?\n\}\);\s*\n/g;
const before = cv.length;
cv = cv.replace(brokenRe, "");
const removed = before - cv.length;
console.log("[1] complete-v1.js removed bytes:", removed);
if (removed === 0) {
  console.error("!! No broken handler found in complete-v1.js. Aborting.");
  process.exit(1);
}
fs.writeFileSync("src/routes/complete-v1.js", cv);

// 2) Kill any leftover handler in server.js too
let sv = fs.readFileSync("server.js", "utf8");
sv = sv.replace(/app\.post\(\s*["']\/api\/v1\/chat\/conversations["']\s*,[\s\S]*?\n\}\);\s*\n/g, "");
fs.writeFileSync("server.js", sv);

// 3) Syntax check
try {
  execSync("node --check src/routes/complete-v1.js", { stdio: "pipe" });
  execSync("node --check server.js", { stdio: "pipe" });
  console.log("[2] syntax OK on both files");
} catch (e) {
  console.error("[2] SYNTAX FAIL:", (e.stderr ? e.stderr.toString().slice(0, 500) : e.message));
  process.exit(1);
}
