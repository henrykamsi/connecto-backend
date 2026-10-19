const fs = require("fs");
const path = "server.js";

let src = fs.readFileSync(path, "utf8");

if (src.includes("[MUSIC-B2-SAFE]")) {
  console.log("SKIP: Music B2 already patched.");
  process.exit(0);
}

// 1. Safe B2 Client for Music
const b2MusicClient = `
/* [MUSIC-B2-SAFE] Separate B2 Client for Music (Safe start) */
const { S3Client: MusicS3Client, PutObjectCommand: MusicPutObject } = require("@aws-sdk/client-s3");
let musicB2Client = null;
try {
    if (process.env.MUSIC_B2_KEY_ID && process.env.MUSIC_B2_APP_KEY && process.env.MUSIC_B2_ENDPOINT) {
        musicB2Client = new MusicS3Client({
            endpoint: process.env.MUSIC_B2_ENDPOINT,
            region: process.env.MUSIC_B2_REGION || "us-east-005",
            credentials: {
                accessKeyId: process.env.MUSIC_B2_KEY_ID,
                secretAccessKey: process.env.MUSIC_B2_APP_KEY
            }
        });
        console.log("[MUSIC-B2] Client initialized successfully.");
    } else {
        console.log("[MUSIC-B2] Credentials not found. Music upload disabled.");
    }
} catch (e) {
    console.log("[MUSIC-B2] Initialization failed: " + e.message);
}
`;

// 2. Artist Upload Endpoint
const uploadEndpoint = `
/* [MUSIC-B2-SAFE] Artist Song Upload */
app.post("/api/v1/artist/upload", async (req, res) => {
    try {
        const jwt = require("jsonwebtoken");
        const envLocal = require("./src/config/env");
        const authHeader = req.headers.authorization || "";
        if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
        
        let userId = null;
        try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
        catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

        if (!musicB2Client) {
            return res.status(503).json({ success: false, error: "MUSIC_STORAGE_NOT_CONFIGURED" });
        }

        const { audioBase64, coverUrl, title, artistName } = req.body;
        if (!audioBase64 || !title || !artistName) {
            return res.status(400).json({ success: false, error: "MISSING_FIELDS" });
        }

        const audioBuffer = Buffer.from(audioBase64, 'base64');
        const fileName = \`songs/\${userId}_\${Date.now()}.mp3\`;
        const bucket = process.env.MUSIC_B2_BUCKET || "connecto-music";

        const command = new MusicPutObject({
            Bucket: bucket,
            Key: fileName,
            Body: audioBuffer,
            ContentType: "audio/mpeg"
        });
        
        await musicB2Client.send(command);

        const audioUrl = \`https://\${bucket}.\${process.env.MUSIC_B2_ENDPOINT}/\${fileName}\`;

        const { query } = require("./src/db");
        const { v4: uuidv4 } = require("uuid");
        await query(
            "INSERT INTO sounds (id, user_id, title, artist_name, audio_url, cover_art_url) VALUES ($1, $2, $3, $4, $5, $6)",
            [uuidv4(), userId, title, artistName, audioUrl, coverUrl || null]
        );

        res.json({ success: true, message: "Song uploaded successfully", url: audioUrl });

    } catch (error) {
        console.error("[ARTIST-UPLOAD]", error);
        res.status(500).json({ success: false, error: error.message });
    }
});
`;

// Insert B2 client before the app.get("/") route
const rootRoute = 'app.get("/", (req, res) => {';
if (src.includes(rootRoute)) {
    src = src.replace(rootRoute, b2MusicClient + "\n" + rootRoute);
}

// Insert Upload Endpoint before the error handler
const errorHandler = 'app.use((err, req, res, next) => {';
if (src.includes(errorHandler)) {
    src = src.replace(errorHandler, uploadEndpoint + "\n" + errorHandler);
}

fs.writeFileSync(path, src);
console.log("OK: [MUSIC-B2-SAFE] applied to server.js");
