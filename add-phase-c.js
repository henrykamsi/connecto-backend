const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "control-server.js");

if (!fs.existsSync(target)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");

if (src.includes("[PHASE-C] photo storage ready")) {
  console.log("SKIP: phase C already applied.");
  process.exit(0);
}

const oldBlock = `    await run(
      "UPDATE verification_requests SET real_name=$1, real_surname=$2, age=$3, notes=$4, category=$5, social_links=$6, status='pending' WHERE id=$7",
      [realName, realSurname, age, notes, category, socialLinks, requestId]
    );

    res.json({ success: true, requestId });`;

const newBlock = `    const idPhotoBase64 = String(req.body.idPhotoBase64 || "").trim();
    const idPhotoMime = String(req.body.idPhotoMime || "image/jpeg").trim();

    await run(
      "UPDATE verification_requests SET real_name=$1, real_surname=$2, age=$3, notes=$4, category=$5, social_links=$6, status='pending', passport_image=$7 WHERE id=$8",
      [realName, realSurname, age, notes, category, socialLinks,
       idPhotoBase64 ? (idPhotoMime + "|" + idPhotoBase64) : null,
       requestId]
    );

    console.log("[PHASE-C] photo storage ready");

    res.json({ success: true, requestId });`;

if (!src.includes(oldBlock)) {
  console.error("ERROR: could not find the /verification/submit block to patch.");
  const idx = src.indexOf("/verification/submit");
  if (idx !== -1) {
    console.log("Found /verification/submit at index:", idx);
    console.log("Context:");
    console.log(src.slice(idx, idx + 800));
  }
  process.exit(1);
}

src = src.replace(oldBlock, newBlock);
fs.writeFileSync(target, src);
console.log("OK: phase C photo storage patched");
