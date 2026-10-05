const fs = require("fs");
const path = "server.js";

let src = fs.readFileSync(path, "utf8");

const line = 'const env = require("./src/config/env");';
const lines = src.split("\n");

let seen = false;
let removed = 0;

const cleaned = lines.map(l => {
  if (l.trim() === line) {
    if (seen) {
      removed++;
      return "// (removed duplicate env import)";
    }
    seen = true;
    return l;
  }
  return l;
});

fs.writeFileSync(path, cleaned.join("\n"));
console.log("OK: removed " + removed + " duplicate env import(s)");
