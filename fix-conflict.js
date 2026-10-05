const fs = require("fs");
const path = "control-server.js";

let src = fs.readFileSync(path, "utf8");

const startMarker = "<<<<<<< HEAD\n";
const midMarker = "\n=======\n";
const endMarkerRegex = /\n>>>>>>> [^\n]*\n/;

const startIdx = src.indexOf(startMarker);

if (startIdx === -1) {
  console.log("NO CONFLICT FOUND — nothing to fix");
  process.exit(0);
}

const midIdx = src.indexOf(midMarker, startIdx);
const afterMid = midIdx + midMarker.length;

const matchEnd = src.slice(afterMid).match(endMarkerRegex);
if (!matchEnd) {
  console.error("ERROR: end marker not found");
  process.exit(1);
}

const endIdx = afterMid + matchEnd.index + matchEnd[0].length;

const ours = src.slice(startIdx + startMarker.length, midIdx);
const theirs = src.slice(afterMid, afterMid + matchEnd.index);

const merged = ours + theirs;

const newSrc = src.slice(0, startIdx) + merged + src.slice(endIdx);

fs.writeFileSync(path, newSrc);
console.log("OK: conflict resolved, both sides kept");
