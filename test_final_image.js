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

  console.log("2. Logging in...");
  const loginRes = await fetch(BASE + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD })
  });
  const loginData = await loginRes.json();
  const token = loginData.accessToken;

  console.log("3. Fetching a real knife image...");
  // This is a direct link to a real image (Wikimedia scaled to standard 250px size)
  const imgRes = await fetch("https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Kitchen_knife.jpg/250px-Kitchen_knife.jpg");
  if (!imgRes.ok) {
      console.error("Image download failed:", imgRes.status);
      process.exit(1);
  }
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  console.log("   -> Downloaded: " + imgBuffer.length + " bytes");

  const uploadUrlRes = await fetch(BASE + "/api/v1/media/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ content_type: "image/jpeg", file_size: imgBuffer.length, media_type: "image" })
  });
  const uploadData = await uploadUrlRes.json();
  
  await fetch(uploadData.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: imgBuffer
  });

  await fetch(BASE + "/api/v1/media/" + uploadData.media_id + "/complete", {
    method: "POST", headers: { "Authorization": "Bearer " + token }
  });

  console.log("4. Creating the post...");
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
  console.log("\n=== RESULT ===");
  console.log("warning_label: " + (postData.post.warning_label || "null"));
  process.exit(0);
})();
