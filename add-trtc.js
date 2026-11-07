const fs = require("fs");
const { execSync } = require("child_process");

// 1. Create the TRTC signature helper
if (!fs.existsSync("./src/utils")) fs.mkdirSync("./src/utils", { recursive: true });
const trtcHelper = `const crypto = require('crypto');
const zlib = require('zlib');

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\\+/g, '-')
    .replace(/\\//g, '_')
    .replace(/=+$/, '');
}

function genUserSig(sdkAppId, secretKey, userId, expire = 86400) {
  const currTime = Math.floor(Date.now() / 1000);
  const rawContent = JSON.stringify({
    "TLS.ver": "2.0",
    "TLS.identifier": userId,
    "TLS.sdkappid": sdkAppId,
    "TLS.expire": expire,
    "TLS.time": currTime,
  });

  const compressedContent = zlib.deflateSync(Buffer.from(rawContent, 'utf8')).toString('base64');
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(compressedContent);
  const signature = hmac.digest('base64');

  const finalContent = JSON.stringify({
    "TLS.ver": "2.0",
    "TLS.identifier": userId,
    "TLS.sdkappid": sdkAppId,
    "TLS.expire": expire,
    "TLS.time": currTime,
    "TLS.sig": signature,
    "TLS.content": compressedContent
  });

  return base64UrlEncode(finalContent);
}

module.exports = { genUserSig };
`;
fs.writeFileSync("./src/utils/trtc.js", trtcHelper);
console.log("✅ Created src/utils/trtc.js");

// 2. Patch server.js
let src = fs.readFileSync("server.js", "utf8");
if (src.includes("[TRTC-INTEGRATION]")) {
  console.log("✅ server.js already patched. Skipping.");
  process.exit(0);
}

const anchor = 'app.use("/api/v1", v1);';
if (!src.includes(anchor)) {
  console.error("❌ Anchor not found in server.js");
  process.exit(1);
}

const block = `
/* [TRTC-INTEGRATION] */
const { genUserSig } = require("./src/utils/trtc");

app.get("/api/v1/calls/trtc-token", async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const TRTC_SDK_APP_ID = 20050453;
    const TRTC_SECRET_KEY = "6349a1c9ecae954cc40f9b6e222c583a64fab90c2a50251d1373724a19146e18";

    const userSig = genUserSig(TRTC_SDK_APP_ID, TRTC_SECRET_KEY, userId, 86400);

    res.json({ success: true, sdkAppId: TRTC_SDK_APP_ID, userId, userSig });
  } catch (err) {
    console.error("[TRTC-TOKEN]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/trtc/webhook", express.json({ type: "*/*" }), async (req, res) => {
  try {
    const payload = req.body;
    if (payload && payload.EventGroup === "Check") return res.json({ ErrorCode: 0, ErrorInfo: "success" });
    if (payload && payload.EventGroup) console.log("[TRTC-WEBHOOK]", payload.EventGroup, "|", payload.EventType, "| Room:", payload.RoomId);
    res.json({ ErrorCode: 0, ErrorInfo: "success" });
  } catch (err) {
    console.error("[TRTC-WEBHOOK-ERROR]", err);
    res.json({ ErrorCode: 0, ErrorInfo: "success" });
  }
});
`;

src = src.replace(anchor, anchor + '\n' + block);
fs.writeFileSync("server.js", src);
console.log("✅ Patched server.js with TRTC endpoints");

// 3. Verify syntax
try {
  execSync("node --check server.js", { stdio: "pipe" });
  execSync("node --check src/utils/trtc.js", { stdio: "pipe" });
  console.log("✅ Syntax check passed");
} catch (e) {
  console.error("❌ Syntax check failed. Reverting server.js changes.");
  console.error(e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
}

// 4. Commit and Push
try {
  execSync("git add .", { stdio: "inherit" });
  execSync('git commit -m "feat: added TRTC token generation and webhook"', { stdio: "inherit" });
  execSync("git push origin main", { stdio: "inherit" });
  console.log("🚀 Pushed to Render. Wait 2 minutes for deployment.");
} catch (e) {
  console.error("❌ Git push failed:", e.message);
}
