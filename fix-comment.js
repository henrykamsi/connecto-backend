const fs = require("fs");
const path = "control-server.js";

let src = fs.readFileSync(path, "utf8");

const broken = 'console.log("[CONTROL] new endpoints ready"); * PHASE A - Verification endpoints, bookmarks';
const fixed = 'console.log("[CONTROL] new endpoints ready");\n\n/* ============================================================================\n * PHASE A - Verification endpoints, bookmarks';

if (!src.includes(broken)) {
  console.log("NO MATCH — checking for other issues...");
  // show surrounding lines for debugging
  const idx = src.indexOf("[CONTROL] new endpoints ready");
  if (idx !== -1) {
    console.log("Found at index:", idx);
    console.log(JSON.stringify(src.slice(idx - 50, idx + 200)));
  } else {
    console.log("Not found at all");
  }
  process.exit(1);
}

src = src.replace(broken, fixed);
fs.writeFileSync(path, src);
console.log("OK: comment fixed");
