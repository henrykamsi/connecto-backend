const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// Remove the previous failed interceptors so they don't conflict
src = src.replace(/\/\* \[FINAL-MODERATION\] \*\/[\s\S]*?next\(\);\n\}\);/g, "");
src = src.replace(/\/\* \[ABSOLUTE-MODERATION-INTERCEPTOR\] \*\/[\s\S]*?next\(\);\n\}\);/g, "");

// Find the POST /api/v1/posts route
const routeStart = src.indexOf('app.post("/api/v1/posts"');
if (routeStart === -1) {
  console.error("Could not find POST /api/v1/posts route");
  process.exit(1);
}

// Inject the GPT call right before the INSERT statement
const insertIdx = src.indexOf('INSERT INTO posts', routeStart);
if (insertIdx === -1) {
  console.error("Could not find INSERT INTO posts");
  process.exit(1);
}

const gptBlock = `
    // [DIRECT-GPT-MODERATION]
    let clientWarningLabel = null;
    try {
      const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
      if (keys.length > 0 && req.body.body) {
        const payload = JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "text", text: req.body.body }] });
        for (const key of keys) {
          const r = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
            body: payload
          });
          if (r.ok) {
            const data = await r.json();
            const cats = data.results[0].categories || {};
            if (cats["sexual"] || cats["sexual/minors"]) clientWarningLabel = "NUDITY CONTENT (18+)";
            else if (cats["violence"] || cats["violence/graphic"]) clientWarningLabel = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
            else if (cats["self-harm"]) clientWarningLabel = "DO NOT TRY THIS";
            else if (cats["harassment"] || cats["hate"]) clientWarningLabel = "INAPPROPRIATE CONTENT";
            break;
          }
        }
      }
    } catch (e) { console.error("[DIRECT-GPT-ERROR]", e.message); }

`;

// Insert the GPT block just before the INSERT statement
src = src.slice(0, insertIdx) + gptBlock + src.slice(insertIdx);

// Now, we need to update the INSERT statement to save clientWarningLabel
const oldInsertRegex = /INSERT INTO posts\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i;
const match = src.match(oldInsertRegex);

if (match) {
  let columns = match[1];
  let values = match[2];
  
  // Only add warning_label if it's not already there
  if (!columns.includes("warning_label")) {
    columns += ", warning_label, warning_label_style";
    values += ", $100, $101"; // Using unique placeholders
    src = src.replace(oldInsertRegex, `INSERT INTO posts (${columns}) VALUES (${values})`);
    
    // Find the params array `[...]` immediately following the INSERT to add the variables
    const argsRegex = /\[\s*postId,[^\]]+\]/;
    const argsMatch = src.slice(insertIdx).match(argsRegex);
    
    if (argsMatch) {
      const oldArgs = argsMatch[0];
      const newArgs = oldArgs.replace("]", ", clientWarningLabel, clientWarningLabel ? 'danger' : null]");
      src = src.slice(0, insertIdx) + src.slice(insertIdx).replace(oldArgs, newArgs);
      console.log("[1] Patched INSERT and args successfully.");
    } else {
      console.error("[1] Could not find args array.");
    }
  }
}

fs.writeFileSync("server_check_tmp.js", src);
try {
  execSync("node --check server_check_tmp.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
fs.unlinkSync("server_check_tmp.js");
fs.writeFileSync("server.js", src);
