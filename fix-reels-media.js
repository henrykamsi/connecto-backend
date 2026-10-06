const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[REELS-MEDIA-FIX]")) {
  console.log("SKIP: already fixed");
  process.exit(0);
}

const oldBlock = `res.json({ success: true, posts: r.rows, pagination: { limit, offset } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

`;

// Only match inside the REELS endpoint specifically
const anchor = `/* [REELS-ENDPOINT] Paginated video feed, one video per user, newest first */`;

if (!srv.includes(anchor)) {
  console.error("ERROR: reels endpoint not found");
  process.exit(1);
}

const fix = `
// [REELS-MEDIA-FIX] Sign B2 storage keys into playable URLs
`;

// We need to insert signing logic right before res.json in the reels endpoint.
// Find the reels endpoint block
const reelsStart = srv.indexOf(anchor);
if (reelsStart === -1) {
  console.error("ERROR: reels block not found");
  process.exit(1);
}

const reelsEnd = srv.indexOf("/* [SOUNDS-ENDPOINTS]", reelsStart);
if (reelsEnd === -1) {
  console.error("ERROR: could not find end of reels block");
  process.exit(1);
}

let reelsBlock = srv.slice(reelsStart, reelsEnd);

// Replace the plain res.json with a signed version
const oldRes = `    res.json({ success: true, posts: r.rows, pagination: { limit, offset } });`;

if (!reelsBlock.includes(oldRes)) {
  console.error("ERROR: res.json line not found in reels block");
  console.log("Looking for:");
  console.log(oldRes);
  process.exit(1);
}

const newRes = `    const b2Provider = require("./src/providers/b2");
    const signedPosts = await Promise.all(r.rows.map(async (row) => {
      let mediaUrl = null;
      if (row.media_url) {
        try {
          if (String(row.media_url).indexOf("http") === 0) {
            mediaUrl = row.media_url;
          } else {
            mediaUrl = await b2Provider.signedDownload(row.media_url, 3600);
          }
        } catch (e) {
          console.error("[REELS-MEDIA-SIGN]", e.message);
        }
      }
      return { ...row, media_url: mediaUrl };
    }));

    res.json({ success: true, posts: signedPosts, pagination: { limit, offset } });`;

reelsBlock = reelsBlock.replace(oldRes, newRes);

srv = srv.slice(0, reelsStart) + reelsBlock + srv.slice(reelsEnd);

fs.writeFileSync(path, srv);
console.log("OK: reels endpoint now signs media URLs");
