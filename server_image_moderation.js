const fs = require("fs");
const { execSync } = require("child_process");

let src = fs.readFileSync("server.js", "utf8");

// Find the POST /api/v1/posts route and inject image moderation before the DB insert
const insertAnchor = /const postId = uuidv4\(\);/;
const imageModBlock = `
    let imageWarningLabel = null;
    try {
      const mediaUrl = req.body.media_url;
      if (mediaUrl && (mediaUrl.startsWith("http") || mediaUrl.includes(".jpg") || mediaUrl.includes(".png"))) {
        const imageResp = await fetch(mediaUrl);
        const arrayBuffer = await imageResp.arrayBuffer();
        const base64Image = Buffer.from(arrayBuffer).toString("base64");
        
        const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
        if (keys.length > 0) {
          const bodyPayload = JSON.stringify({
            model: "omni-moderation-latest",
            input: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } }]
          });
          
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
                if (cats["sexual"] || cats["sexual/minors"]) imageWarningLabel = "NUDITY CONTENT (18+)";
                else if (cats["violence"] || cats["violence/graphic"]) imageWarningLabel = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
                else if (cats["self-harm"]) imageWarningLabel = "DO NOT TRY THIS";
                else if (cats["harassment"] || cats["hate"]) imageWarningLabel = "INAPPROPRIATE CONTENT";
                break; // stop trying keys if successful
              }
            } catch (e) { console.warn("[IMG-MOD-KEY-FAIL]", e.message); }
          }
        }
      }
    } catch (e) {
      console.error("[SERVER-IMAGE-MODERATION-ERROR]", e.message);
    }
`;

if (src.match(insertAnchor)) {
    src = src.replace(insertAnchor, imageModBlock + "\n    const postId = uuidv4();");
    console.log("[PATCH] Injected image moderation into POST /posts");
} else {
    console.log("[WARN] Could not find postId anchor. Image moderation not injected.");
}

// Now, make sure the INSERT saves it if the client didn't send one
src = src.replace(
    /warningLabel \|\| clientWarningLabel/,
    "warningLabel || imageWarningLabel || clientWarningLabel"
);

fs.writeFileSync("server.js", src);
try {
  execSync("node --check server.js", { stdio: "pipe" });
  console.log("[OK] syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", (e.stderr ? e.stderr.toString() : e.message).slice(0, 500));
  process.exit(1);
}
