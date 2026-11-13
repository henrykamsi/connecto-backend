const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// Find the moderation logic and add a hard block for sexual content
const oldLogic = `if (cats["sexual"] || cats["sexual/minors"]) warningLabel = "NUDITY CONTENT (18+)";`;
const newLogic = `
let isHardBlocked = false;
              const scores = data.results[0].category_scores || {};
              if (cats["sexual"] || cats["sexual/minors"]) {
                if (scores["sexual"] > 0.99) {
                  isHardBlocked = true;
                  return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" });
                }
                warningLabel = "NUDITY CONTENT (18+)";
              }`;

if (modSrc.includes(oldLogic)) {
  modSrc = modSrc.replace(oldLogic, newLogic);
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Added hard-block for explicit nudity (score > 0.99)");
} else {
  console.log("[1] Could not find moderation logic in moderation.js");
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
