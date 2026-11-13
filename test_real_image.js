require("dotenv").config();
const { query, run } = require("./src/db");

(async () => {
  console.log("1. Cleaning old posts...");
  try {
    await run("DELETE FROM media WHERE post_id IS NOT NULL");
    await run("DELETE FROM posts");
    console.log("   -> Database cleaned.");
  } catch (e) {}

  const BASE = "https://connecto-backend-luxa.onrender.com";
  const EMAIL = "kamsih924@gmail.com";
  const PASSWORD = "35056808";

  // Login
  console.log("2. Logging in...");
  const loginRes = await fetch(BASE + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD })
  });
  const loginData = await loginRes.json();
  if (!loginData.success) { console.error(loginData); process.exit(1); }
  const token = loginData.accessToken;

  // Download image with proper User-Agent
  console.log("3. Downloading knife image...");
  const imgUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Kitchen_knife.jpg/640px-Kitchen_knife.jpg";
  
  const imgRes = await fetch(imgUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });
  
  if (!imgRes.ok) { 
    console.error("Image download failed:", imgRes.status, imgRes.statusText); 
    process.exit(1); 
  }
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  console.log("   -> Downloaded: " + imgBuffer.length + " bytes");

  // Get upload URL
  console.log("4. Requesting upload URL from server...");
  const uploadUrlRes = await fetch(BASE + "/api/v1/media/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ content_type: "image/jpeg", file_size: imgBuffer.length, media_type: "image" })
  });
  const uploadData = await uploadUrlRes.json();
  if (!uploadData.success) { console.error("Upload URL failed:", uploadData); process.exit(1); }
  console.log("   -> Upload URL OK");

  // Upload to B2
  console.log("5. Uploading to B2...");
  const putRes = await fetch(uploadData.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: imgBuffer
  });
  if (!putRes.ok) { 
    console.error("B2 PUT failed:", putRes.status); 
    const errText = await putRes.text();
    console.error("Response:", errText);
    process.exit(1); 
  }
  console.log("   -> B2 upload OK");

  // Mark media complete
  console.log("6. Completing media...");
  await fetch(BASE + "/api/v1/media/" + uploadData.media_id + "/complete", {
    method: "POST", headers: { "Authorization": "Bearer " + token }
  });

  // Create post with media_id
  console.log("7. Creating the post with the knife image...");
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
    if (postData.post.warning_label) {
      console.log("\n✅ SUCCESS! The label was saved: " + postData.post.warning_label);
      if (postData.post.media_url) {
        console.log("✅ Media URL attached: " + postData.post.media_url.substring(0, 80));
      } else {
        console.log("❌ Media URL is missing from the response.");
      }
    } else {
      console.log("\n❌ FAILED. The label is null.");
    }
  }
  
  process.exit(0);
})();
