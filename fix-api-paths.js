const fs = require("fs");
const path = "control-server.js";

if (!fs.existsSync(path)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(path, "utf8");

if (src.includes("[FIX-API-PATHS-V2]")) {
  console.log("SKIP: paths already fixed.");
  process.exit(0);
}

// Change every /api/v1/... route we added inside control-server.js
// to /v1/... because the router is mounted at /control-api.
// So the full external URL becomes /control-api/v1/...

const replacements = [
  ['router.post("/api/v1/verification/submit"',   'router.post("/v1/verification/submit"'],
  ['router.post("/api/v1/verification/verify-domain"', 'router.post("/v1/verification/verify-domain"'],
  ['router.get("/api/v1/me/bookmarks"',           'router.get("/v1/me/bookmarks"'],
  ['router.get("/api/v1/pending-verification"',   'router.get("/v1/pending-verification"'],
  ['router.post("/api/v1/pending-verification/:id/accept"',  'router.post("/v1/pending-verification/:id/accept"'],
  ['router.post("/api/v1/pending-verification/:id/decline"', 'router.post("/v1/pending-verification/:id/decline"'],
];

let count = 0;
for (const [from, to] of replacements) {
  if (src.includes(from)) {
    src = src.replace(from, to);
    count++;
  }
}

src = src.replace(
  "/* [FIX-SUBMIT-PATH] Aliases so Android's /api/v1/* calls hit /control-api/* handlers */",
  "/* [FIX-API-PATHS-V2] Aliases. Mounted at /control-api, so paths are /v1/... */"
);

fs.writeFileSync(path, src);
console.log("OK: replaced " + count + " route paths");
