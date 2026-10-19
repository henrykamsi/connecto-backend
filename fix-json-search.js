const fs = require("fs");
let src = fs.readFileSync("server.js", "utf8");

// Find the exact line where the search returns
const brokenResponse = `res.json({ success: true, mode, users, videos, music });`;
const fixedResponse = `res.json({ success: true, mode, query_used: query, users, videos, music, counts: { users: users.length, videos: videos.length } });`;

if (src.includes(brokenResponse)) {
    src = src.replace(brokenResponse, fixedResponse);
    fs.writeFileSync("server.js", src);
    console.log("OK: Search JSON now matches Android expectations.");
} else {
    console.log("Could not find the response line. Checking if already fixed...");
}
