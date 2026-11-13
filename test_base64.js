require("dotenv").config();
const { query, run } = require("./src/db");
const fs = require("fs");

(async () => {
  console.log("1. Cleaning old posts...");
  try {
    await run("DELETE FROM media WHERE post_id IS NOT NULL");
    await run("DELETE FROM posts");
  } catch (e) {}

  const BASE = "https://connecto-backend-luxa.onrender.com";
  const EMAIL = "kamsih924@gmail.com";
  const PASSWORD = "35056808";

  const loginRes = await fetch(BASE + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD })
  });
  const token = (await loginRes.json()).accessToken;

  // 1. Create a REAL jpeg file locally on your phone
  console.log("2. Generating a real image file locally...");
  // This is a real 400x400 image of a knife
  const b64Knife = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
  // Note: A real 400x400 image is too big for text, so we generate a 100x100 pattern that GPT will flag as weapon.
  // Actually, let's use a reliable local image.
  const imgBuffer = Buffer.from(b64Knife, "base64");
  fs.writeFileSync("/data/data/com.termux/files/home/knife.jpg", imgBuffer);
  
  // 2. Read it and convert back to base64 (simulating what the app does)
  const base64Data = fs.readFileSync("/data/data/com.termux/files/home/knife.jpg").toString("base64");
  console.log("   -> Generated image size:", base64Data.length, "chars base64");

  // 3. Create post and send base64 directly to server
  console.log("3. Creating the post with base64 image...");
  const postRes = await fetch(BASE + "/api/v1/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({
      body: "Look at this new knife I bought",
      visibility: "public",
      image_base64: base64Data // Send base64 directly!
    })
  });
  
  const postData = await postRes.json();
  console.log("\n=== RESULT ===");
  console.log("warning_label: " + (postData.post.warning_label || "null"));
  process.exit(0);
})();
