require("dotenv").config();
const { query } = require("./src/db");

async function main() {
  const r = await query(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  );
  console.log("TABLES IN DB:");
  for (const row of r.rows) console.log(" -", row.name);
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
