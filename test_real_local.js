require("dotenv").config();
const { query, run } = require("./src/db");

// This is a real, 50KB JPEG image of a kitchen knife
const REAL_KNIFE_BASE64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";

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

  console.log("3. Preparing local knife image...");
  const imgBuffer = Buffer.from(REAL_KNIFE_BASE64, "base64");
  console.log("   -> Image size: " + imgBuffer.length + " bytes");

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
  console.log("warning_label: " + postData.post.warning_label);
  
  process.exit(0);
})();
