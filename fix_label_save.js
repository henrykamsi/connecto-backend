const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// Find the POST /api/v1/posts route and replace the INSERT logic to accept warning_label
const oldInsertRegex = /INSERT INTO posts \(id, author_id, text, audience, comments_enabled, share_enabled, is_ai_content, warning_label, warning_label_style\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9\)/;
const newInsert = `INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, is_ai_content, warning_label, warning_label_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;

if (!src.match(oldInsertRegex)) {
    // Try the other variant (without is_ai_content)
    const oldRegex2 = /INSERT INTO posts \(id, author_id, text, audience, comments_enabled, share_enabled, warning_label, warning_label_style\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8\)/;
    const newInsert2 = `INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, warning_label, warning_label_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    
    if (src.match(oldRegex2)) {
        src = src.replace(oldRegex2, newInsert2);
        console.log("[PATCH] Updated INSERT statement (variant 2)");
    } else {
        console.log("[WARN] Could not find exact INSERT statement to patch. Proceeding anyway.");
    }
} else {
    src = src.replace(oldInsertRegex, newInsert);
    console.log("[PATCH] Updated INSERT statement (variant 1)");
}

// Now patch the req.body extraction part to pull warning_label from the request
const bodyExtractRegex = /const isAiContent = req\.body\.is_ai_content \? 1 : 0;/;
const newBodyExtract = `
const isAiContent = req.body.is_ai_content ? 1 : 0;
const clientWarningLabel = req.body.warning_label || null;
const clientWarningStyle = req.body.warning_label_style || (clientWarningLabel ? "danger" : null);
`;
if (src.match(bodyExtractRegex)) {
    src = src.replace(bodyExtractRegex, newBodyExtract);
    console.log("[PATCH] Added clientWarningLabel extraction");
}

// Update the arrays passed to run() to include the warning variables
const runArgsRegex = /\[postId, userId, text, visibility, commentsEnabled, shareEnabled, isAiContent, warningLabel, warningStyle\]/;
if (src.match(runArgsRegex)) {
    src = src.replace(runArgsRegex, `[postId, userId, text, visibility, commentsEnabled, shareEnabled, isAiContent, warningLabel || clientWarningLabel, warningStyle || clientWarningStyle]`);
    console.log("[PATCH] Updated run arguments");
} else {
    // Alternative array args regex
    const altArgsRegex = /\[postId, userId, text, visibility, commentsEnabled, shareEnabled, warningLabel, warningStyle\]/;
    if (src.match(altArgsRegex)) {
        src = src.replace(altArgsRegex, `[postId, userId, text, visibility, commentsEnabled, shareEnabled, warningLabel || clientWarningLabel, warningStyle || clientWarningStyle]`);
        console.log("[PATCH] Updated run arguments (alt)");
    } else {
         console.log("[WARN] Could not find run arguments to patch.");
    }
}

fs.writeFileSync("server.js", src);
try {
  execSync("node --check server.js", { stdio: "pipe" });
  console.log("[OK] syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", (e.stderr ? e.stderr.toString() : e.message).slice(0, 500));
  process.exit(1);
}
