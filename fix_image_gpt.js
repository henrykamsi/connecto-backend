const fs = require("fs");
const { execSync } = require("child_process");

let modSrc = fs.readFileSync("moderation.js", "utf8");

// Find the part where we check for mediaUrl
const oldBlock = `if (mediaUrl && mediaUrl.startsWith("http")) {
        input.push({ type: "image_url", image_url: { url: mediaUrl } });
      }`;

const newBlock = `if (mediaUrl && mediaUrl.startsWith("http")) {
        try {
          // Download the image from B2 and convert to Base64 so GPT can read it
          const imgRes = await fetch(mediaUrl);
          if (imgRes.ok) {
            const arrayBuffer = await imgRes.arrayBuffer();
            const base64Img = Buffer.from(arrayBuffer).toString("base64");
            const mime = imgRes.headers.get("content-type") || "image/jpeg";
            input.push({ type: "image_url", image_url: { url: "data:" + mime + ";base64," + base64Img } });
          }
        } catch (e) {
          console.warn("[IMG-DOWNLOAD-FAIL]", e.message);
        }
      }`;

if (modSrc.includes(oldBlock)) {
  modSrc = modSrc.replace(oldBlock, newBlock);
  fs.writeFileSync("moderation.js", modSrc);
  console.log("[1] Updated moderation.js to download and base64-encode images for GPT");
} else {
  console.error("[1] Could not find the image block in moderation.js");
}

try {
  execSync("node --check moderation.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
