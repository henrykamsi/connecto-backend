const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// 1. Add a global interceptor that runs BEFORE your routes
const interceptor = `
/* [FORCE-MODERATION] Intercept POST /posts, moderate text, save warning label */
app.use(async (req, res, next) => {
  if (req.method !== "POST" || !req.path.endsWith("/posts")) return next();

  const text = req.body.body || req.body.text;
  if (!text || text.length < 3) return next();

  try {
    const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) return next();

    const bodyPayload = JSON.stringify({
      model: "omni-moderation-latest",
      input: [{ type: "text", text: text }]
    });

    let warningLabel = null;
    for (const key of keys) {
      try {
        const r = await fetch("https://api.openai.com/v1/moderations", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
          body: bodyPayload
        });
        if (r.ok) {
          const data = await r.json();
          const result = data.results[0];
          const cats = result.categories || {};
          if (cats["sexual"] || cats["sexual/minors"]) warningLabel = "NUDITY CONTENT (18+)";
          else if (cats["violence"] || cats["violence/graphic"]) warningLabel = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
          else if (cats["self-harm"]) warningLabel = "DO NOT TRY THIS";
          else if (cats["harassment"] || cats["hate"]) warningLabel = "INAPPROPRIATE CONTENT";
          break;
        }
      } catch (e) { console.warn("[FORCE-MOD-KEY-FAIL]", e.message); }
    }

    // Attach the label to the request so the route can save it
    if (warningLabel) {
      req.body.warning_label = warningLabel;
      req.body.warning_label_style = "danger";
      console.log("[FORCE-MODERATION] Detected bad text. Label:", warningLabel);
    }
  } catch (e) {
    console.error("[FORCE-MODERATION-ERROR]", e.message);
  }
  next();
});
`;

// Find where to insert it. Right after `app.use(express.json())` is perfect.
const jsonAnchor = /app\.use\(express\.json\(\s*\{[\s\S]*?\}\s*\)\);/;
if (src.match(jsonAnchor)) {
  src = src.replace(jsonAnchor, match => match + "\n\n" + interceptor);
  console.log("[1] Injected middleware after express.json()");
} else {
  // Fallback: just put it at the top
  src = interceptor + "\n\n" + src;
  console.log("[1] Injected middleware at top of file (fallback)");
}

// 2. Now patch the POST /posts route to actually save req.body.warning_label
// Find the INSERT INTO posts
const oldInsertRegex = /INSERT INTO posts\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i;
const match = src.match(oldInsertRegex);

if (match) {
  const columns = match[1];
  const values = match[2];
  if (!columns.includes("warning_label")) {
    // Add warning_label to the insert
    const newColumns = columns + ", warning_label, warning_label_style";
    const newValues = values + ", $8, $9"; // Assuming $8 and $9 are free
    src = src.replace(oldInsertRegex, `INSERT INTO posts (${newColumns}) VALUES (${newValues})`);
    console.log("[2] Patched INSERT statement to include warning_label");
    
    // We also need to ensure the arguments passed match
    // This is tricky to regex, but we'll try to add it to the array
    const argsRegex = /\[postId, userId, text, visibility, commentsEnabled, shareEnabled, isAiContent\]/;
    if (src.match(argsRegex)) {
      src = src.replace(argsRegex, `[postId, userId, text, visibility, commentsEnabled, shareEnabled, isAiContent, req.body.warning_label || null, req.body.warning_label_style || null]`);
      console.log("[3] Patched arguments array");
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
console.log("[OK] server.js updated");
