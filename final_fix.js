const fs = require("fs");
const { execSync } = require("child_process");

// 1. Patch server.js: hook into the response of POST /posts
let src = fs.readFileSync("server.js", "utf8");

// Remove the old interceptor if it exists
src = src.replace(/\/\* \[ABSOLUTE-MODERATION-INTERCEPTOR\] \*\/[\s\S]*?next\(\);\n\}\);/g, "");

const newInterceptor = `
/* [FINAL-MODERATION] */
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = async function(body) {
    if (req.method === 'POST' && req.path.endsWith('/posts') && body && body.post && body.post.id) {
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
              let label = null;
              if (cats["sexual"] || cats["sexual/minors"]) label = "NUDITY CONTENT (18+)";
              else if (cats["violence"] || cats["violence/graphic"]) label = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
              else if (cats["self-harm"]) label = "DO NOT TRY THIS";
              else if (cats["harassment"] || cats["hate"]) label = "INAPPROPRIATE CONTENT";
              
              if (label) {
                const { run } = require("./src/db");
                await run("UPDATE posts SET warning_label=$1, warning_label_style='danger' WHERE id=$2", [label, body.post.id]);
                body.post.warning_label = label;
                body.post.warning_label_style = "danger";
                console.log("[FINAL-MOD] Labeled post:", label);
              }
              break;
            }
          }
        }
      } catch (e) { console.error("[FINAL-MOD-ERROR]", e.message); }
    }
    return originalJson(body);
  };
  next();
});
`;

// Insert right after express.json()
src = src.replace(/app\.use\(express\.json\(\s*\{[\s\S]*?\}\s*\)\);/, match => match + "\n\n" + newInterceptor);

// 2. Deduplicate smart-feed so Android doesn't crash on duplicate keys
const sfPath = "src/routes/smart-feed.js";
if (fs.existsSync(sfPath)) {
  let sf = fs.readFileSync(sfPath, "utf8");
  // In the final return block, dedupe by id:
  sf = sf.replace(
    "const signed = await signMedia(out);",
    `const seen = new Set();\n    const uniqueOut = out.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });\n    const signed = await signMedia(uniqueOut);`
  );
  fs.writeFileSync(sfPath, sf);
  console.log("[2] smart-feed.js deduplicated");
}

fs.writeFileSync("server_check_tmp.js", src);
try {
  execSync("node --check server_check_tmp.js", { stdio: "pipe" });
  if (fs.existsSync(sfPath)) execSync("node --check src/routes/smart-feed.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
fs.unlinkSync("server_check_tmp.js");
fs.writeFileSync("server.js", src);
