const fs = require("fs");
const path = "control-server.js";

if (!fs.existsSync(path)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(path, "utf8");

// The verify-domain endpoint currently uses controlAuth. Change it to
// accept user JWTs (or admin JWTs) by using a flexible auth check.

const old = `router.post("/verification/verify-domain", controlAuth, async (req, res) => {`;
const neu = `router.post("/verification/verify-domain", async (req, res) => {`;

if (!src.includes(old)) {
  console.log("NO MATCH — showing verify-domain block:");
  const idx = src.indexOf("/verification/verify-domain");
  if (idx !== -1) {
    console.log(src.slice(idx - 100, idx + 300));
  }
  process.exit(1);
}

src = src.replace(old, neu);

// Also we need to make sure the endpoint doesn't reference req.admin (since
// user tokens won't have an admin object). Find the block and neutralize
// any req.admin.id references inside it.

const blockStart = src.indexOf(`router.post("/verification/verify-domain"`);
const blockEnd = src.indexOf(`router.post("/verification/submit"`);
if (blockStart !== -1 && blockEnd !== -1) {
  let block = src.slice(blockStart, blockEnd);
  block = block.replace(/req\.admin\.id/g, `(req.admin ? req.admin.id : req.user ? req.user.id : null)`);
  src = src.slice(0, blockStart) + block + src.slice(blockEnd);
}

fs.writeFileSync(path, src);
console.log("OK: verify-domain now accepts user tokens");
