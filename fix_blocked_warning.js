const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// Find the block logic
const oldLogic = `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) {
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

const newLogic = `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) {
                 // 1. Save a warning to the user's Content Warnings dashboard
                 try {
                   const warnId = uuidv4();
                   const nowIso = new Date().toISOString();
                   // We insert a post record but mark it as deleted so it doesn't show in the feed
                   await run(
                     "INSERT INTO posts (id, author_id, text, warning_label, warning_label_style, deleted_at) VALUES ($1,$2,$3,$4,$5,$6)", 
                     [warnId, me, text || "Blocked Image Upload", "NUDITY CONTENT (18+) - BLOCKED", "danger", nowIso]
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
  console.log("[1] Updated moderation.js to properly save blocked image warnings");
} else {
  // Fallback regex if the exact string matching fails
  const fallback = /if \(\(cats\["sexual"\][\s\S]*?CURRENT_TIMESTAMP"\),[\s\S]*?\]\);/;
  if (fallback.test(modSrc)) {
      modSrc = modSrc.replace(fallback, `if ((cats["sexual"] || cats["sexual/minors"]) && scores["sexual"] > 0.90) {
        try {
          await run("INSERT INTO posts (id, author_id, text, warning_label, warning_label_style, deleted_at) VALUES ($1,$2,$3,$4,$5,$6)", [uuidv4(), me, text || "Blocked Image Upload", "NUDITY CONTENT (18+) - BLOCKED", "danger", new Date().toISOString()]);
        } catch (e) { console.error("[BLOCK-WARN-ERR]", e.message); }
        return res.status(400).json({ success: false, error: "UPLOAD_BLOCKED: Explicit nudity detected" });
      }`);
      fs.writeFileSync("moderation.js", modSrc);
      console.log("[1] Updated moderation.js (fallback regex)");
  } else {
      console.log("[1] Could not find the block logic. You need to check moderation.js manually.");
  }
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
