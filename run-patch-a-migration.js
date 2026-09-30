require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { run, healthCheck } = require("./src/db");

async function main() {
  const ok = await healthCheck();
  if (!ok) throw new Error("DB health check failed");
  console.log("DB: OK");

  const sql = fs.readFileSync(path.join(__dirname, "patch-a-migration.sql"), "utf8");
  const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s.length > 0);

  let success = 0, failed = 0;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await run(stmt);
      success++;
      console.log("[" + (i + 1) + "/" + statements.length + "] OK  " + stmt.slice(0, 60));
    } catch (e) {
      if (e.message && e.message.toLowerCase().includes("duplicate column")) {
        console.log("[" + (i + 1) + "/" + statements.length + "] SKIP (already exists)");
        success++;
      } else {
        failed++;
        console.log("[" + (i + 1) + "/" + statements.length + "] FAIL " + e.message);
      }
    }
  }
  console.log("\nDone. OK: " + success + ", FAIL: " + failed);
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
