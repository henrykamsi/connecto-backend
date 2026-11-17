const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// Find the post creation block
const oldBlock = `await run(
      "INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, is_ai_content, warning_label, warning_label_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [postId, me, text, visibility, commentsEnabled, shareEnabled, isAiContent, warningLabel, warningStyle]
    );`;

const newBlock = `await run(
      "INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, is_ai_content, warning_label, warning_label_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [postId, me, text, visibility, commentsEnabled, shareEnabled, isAiContent, warningLabel, warningStyle]
    );

    // Attach media if provided
    if (req.body.media_id) {
      await run("UPDATE media SET post_id=$1, processing_status='ready', visibility='public' WHERE id=$2 AND owner_id=$3", [postId, req.body.media_id, me]);
    }`;

if (modSrc.includes(oldBlock)) {
  modSrc = modSrc.replace(oldBlock, newBlock);
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Updated moderation.js to attach media_id to the post");
} else {
  console.log("[1] Could not find exact block. Trying fallback...");
  const regex = /await run\(\s*"INSERT INTO posts[\s\S]*?\]\s*\);/;
  if (regex.test(modSrc)) {
    modSrc = modSrc.replace(regex, match => match + `\n\n    if (req.body.media_id) {\n      await run("UPDATE media SET post_id=$1, processing_status='ready', visibility='public' WHERE id=$2 AND owner_id=$3", [postId, req.body.media_id, me]);\n    }`);
    fs.writeFileSync("moderation.js", modSrc);
    console.log("[1] Added media attachment via fallback.");
  } else {
    console.log("[1] Failed to find block. You need to manually add the media attachment to moderation.js.");
  }
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
