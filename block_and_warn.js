const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// Find the exact block where we hard-block nudity
const oldLogic = `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) {
                 return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" });
              }`;

const newLogic = `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) {
                 // 1. Save a warning to the user's Content Warnings dashboard
                 try {
                   const warnId = uuidv4();
                   // We insert a post record but mark it as deleted so it doesn't show in the feed
                   await run(
                     "INSERT INTO posts (id, author_id, text, warning_label, warning_label_style, deleted_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)", 
                     [warnId, me, text || "Blocked Image Upload", "NUDITY CONTENT (18+) - BLOCKED", "danger"]
                   );
                   console.log("[BLOCKED] Saved warning to dashboard for user:", me);
                 } catch (dbErr) {
                   console.error("[BLOCKED-WARN-DB-ERROR]", dbErr.message);
                 }

                 // 2. Block the post
                 return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" });
              }`;

if (modSrc.includes(oldLogic)) {
  modSrc = modSrc.replace(oldLogic, newLogic);
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Updated moderation.js to save warnings to dashboard when blocked");
} else {
  console.log("[1] Could not find the explicit block logic. Checking for older format...");
  // Fallback for older formatting
  const fallbackLogic = `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) { return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" }); }`;
  if (modSrc.includes(fallbackLogic)) {
      const newFallback = `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) {
        try {
          await run("INSERT INTO posts (id, author_id, text, warning_label, warning_label_style, deleted_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)", [uuidv4(), me, text || "Blocked Image Upload", "NUDITY CONTENT (18+) - BLOCKED", "danger"]);
        } catch(e) {}
        return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" });
      }`;
      modSrc = modSrc.replace(fallbackLogic, newFallback);
      fs.writeFileSync("moderation.js", modSrc);
      console.log("[1] Updated moderation.js (fallback format)");
  } else {
      console.log("[1] Could not find logic. You may need to manually edit moderation.js.");
  }
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
