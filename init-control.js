require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { run, healthCheck } = require("./src/db");

async function main() {
  console.log("Testing Turso connection...");

  const healthy = await healthCheck();
  if (!healthy) throw new Error("Turso health check failed");
  console.log("Turso connection: OK");

  const schemaPath = path.join(__dirname, "control-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  // Split on semicolons that end a statement (naive but works for our schema)
  const statements = sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith("--"));

  console.log(`Found ${statements.length} statements.`);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.slice(0, 60).replace(/\s+/g, " ");
    try {
      await run(stmt);
      ok++;
      console.log(`[${i + 1}/${statements.length}] OK  ${preview}`);
    } catch (err) {
      fail++;
      console.log(`[${i + 1}/${statements.length}] FAIL ${preview}`);
      console.log(`    -> ${err.message}`);
    }
  }

  console.log(`\nDone. OK: ${ok}, FAIL: ${fail}`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("INIT FAILED:", e.message);
    process.exit(1);
  });
