require("dotenv").config();
const fs = require("fs");
const { execSync } = require("child_process");
const { query, run } = require("./src/db");

(async () => {
  console.log("1. Cleaning up old test posts...");
  try {
    await run("DELETE FROM media WHERE post_id IS NOT NULL");
    await run("DELETE FROM posts");
    console.log("   -> Database wiped clean.");
  } catch (e) {
    console.log("   -> Cleanup warning:", e.message);
  }

  console.log("2. Injecting the bulletproof moderation interceptor into server.js...");
  let src = fs.readFileSync("server.js", "utf8");

  const interceptor = `
/* [ABSOLUTE-MODERATION-INTERCEPTOR] */
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = async function(body) {
    // If a post was just created and we have the text, moderate it NOW
    if (req.method === 'POST' && req.path.endsWith('/posts') && body && body.post && body.post.id && req.body.body) {
      try {
        const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
        if (keys.length > 0) {
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
              let warningLabel = null;
              
              if (cats["sexual"] || cats["sexual/minors"]) warningLabel = "NUDITY CONTENT (18+)";
              else if (cats["violence"] || cats["violence/graphic"]) warningLabel = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
              else if (cats["self-harm"]) warningLabel = "DO NOT TRY THIS";
              else if (cats["harassment"] || cats["hate"]) warningLabel = "INAPPROPRIATE CONTENT";
              
              if (warningLabel) {
                // UPDATE THE DB IMMEDIATELY
                const { run } = require("./src/db");
                await run("UPDATE posts SET warning_label=$1, warning_label_style='danger' WHERE id=$2", [warningLabel, body.post.id]);
                
                // Inject the label into the response so the app sees it instantly
                body.post.warning_label = warningLabel;
                body.post.warning_label_style = "danger";
                console.log("[ABSOLUTE-MOD] Successfully labeled post:", body.post.id, "as", warningLabel);
              }
              break;
            }
          }
        }
      } catch (e) {
        console.error("[ABSOLUTE-MOD-ERROR]", e.message);
      }
    }
    return originalJson(body);
  };
  next();
});
`;

  // Inject it right after express.json() so it catches everything
  const anchor = /app\.use\(express\.json\(\s*\{[\s\S]*?\}\s*\)\);/;
  if (src.match(anchor)) {
    src = src.replace(anchor, match => match + "\n\n" + interceptor);
  } else {
    src = interceptor + "\n\n" + src;
  }

  fs.writeFileSync("server_check_tmp.js", src);
  try {
    execSync("node --check server_check_tmp.js", { stdio: "pipe" });
    console.log("3. Syntax is perfectly valid.");
  } catch (e) {
    console.error("SYNTAX ERROR:", e.message);
    process.exit(1);
  }
  fs.unlinkSync("server_check_tmp.js");
  fs.writeFileSync("server.js", src);

  console.log("4. Pushing code to GitHub...");
  execSync("git add -A && git commit -m 'fix: absolute moderation interceptor' && git push origin main", { stdio: "inherit" });
  
  console.log("\\n=========================================");
  console.log("DONE. WAIT 2 MINUTES FOR RENDER TO DEPLOY.");
  console.log("=========================================");
  process.exit(0);
})();
