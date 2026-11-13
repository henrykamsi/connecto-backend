require("dotenv").config();
const { query, run } = require("./src/db");

(async () => {
  console.log("1. Deleting old posts...");
  try {
    await run("DELETE FROM media WHERE post_id IS NOT NULL");
    await run("DELETE FROM posts");
    console.log("   -> Database cleaned.");
  } catch (e) {
    console.log("   -> Cleanup warning:", e.message);
  }

  const BASE = "https://connecto-backend-luxa.onrender.com";
  const EMAIL = "kamsih924@gmail.com";
  const PASSWORD = "35056808";

  console.log("\n2. Logging in to get token...");
  const loginRes = await fetch(BASE + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD })
  });
  const loginData = await loginRes.json();
  if (!loginData.success) {
    console.error("LOGIN FAILED:", loginData);
    process.exit(1);
  }
  const token = loginData.accessToken;
  console.log("   -> Token OK");

  console.log("\n3. Creating the dangerous post...");
  const postRes = await fetch(BASE + "/api/v1/posts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify({
      body: "I will kill you and burn your house down",
      visibility: "public",
      commentsEnabled: true,
      shareEnabled: true
    })
  });
  
  const postData = await postRes.json();
  console.log("\n=== POST CREATION RESPONSE ===");
  console.log(JSON.stringify(postData, null, 2));

  if (postData.success && postData.post && postData.post.id) {
    console.log("\n4. Fetching the post from the server to check the label...");
    const fetchRes = await fetch(BASE + "/api/v1/posts/" + postData.post.id, {
      headers: { "Authorization": "Bearer " + token }
    });
    const fetchData = await fetchRes.json();
    
    console.log("\n=== FETCHED POST RESPONSE ===");
    console.log(JSON.stringify(fetchData, null, 2));

    if (fetchData.success && fetchData.post) {
      const label = fetchData.post.warning_label;
      if (label) {
        console.log("\n✅ SUCCESS! The label was saved in the database: " + label);
      } else {
        console.log("\n❌ FAILED. The label is null. The AI did not save the warning.");
      }
    }
  }
  
  process.exit(0);
})();
