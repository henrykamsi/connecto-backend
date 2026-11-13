require("dotenv").config();
const { query, run } = require("./src/db");

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
  const loginData = await loginRes.json();
  const token = loginData.accessToken;
  console.log("2. Logged in.");

  // Download a knife image from the web to simulate the app
  console.log("3. Downloading knife image...");
  const imgRes = await fetch("https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Kitchen_knife.jpg/640px-Kitchen_knife.jpg");
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  
  // We need to upload it to your server first using the /media/upload-url route
  console.log("4. Requesting upload URL...");
  const uploadUrlRes = await fetch(BASE + "/api/v1/media/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ content_type: "image/jpeg", file_size: imgBuffer.length, media_type: "image" })
  });
  const uploadData = await uploadUrlRes.json();
  
  if (!uploadData.success) {
    console.error("UPLOAD URL FAILED (This is the 404 you saw!):", uploadData);
    process.exit(1);
  }

  console.log("5. Uploading to B2...");
  const putRes = await fetch(uploadData.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: imgBuffer
  });
  
  if (!putRes.ok) {
    console.error("B2 UPLOAD FAILED:", putRes.status);
    process.exit(1);
  }

  console.log("6. Completing media...");
  await fetch(BASE + "/api/v1/media/" + uploadData.media_id + "/complete", {
    method: "POST", headers: { "Authorization": "Bearer " + token }
  });

  console.log("7. Creating the post with the image...");
  const postRes = await fetch(BASE + "/api/v1/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({
      body: "Look at this new knife I bought",
      visibility: "public",
      media_id: uploadData.media_id
    })
  });
  
  const postData = await postRes.json();
  console.log("\n=== POST CREATION RESPONSE ===");
  console.log(JSON.stringify(postData, null, 2));
  
  if (postData.success) {
    console.log("\nIs the label there? " + (postData.post.warning_label ? "✅ YES: " + postData.post.warning_label : "❌ NO, it is null."));
  }
  
  process.exit(0);
})();
