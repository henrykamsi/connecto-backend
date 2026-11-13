require("dotenv").config();
const { run, query } = require("./src/db");

(async () => {
  console.log("1. Adding missing columns to the 'posts' table...");
  try {
    await run("ALTER TABLE posts ADD COLUMN warning_label TEXT");
    console.log("   -> Added warning_label column.");
  } catch (e) {
    if (e.message.includes("duplicate column")) console.log("   -> warning_label already exists.");
    else console.log("   -> warning_label error:", e.message);
  }

  try {
    await run("ALTER TABLE posts ADD COLUMN warning_label_style TEXT");
    console.log("   -> Added warning_label_style column.");
  } catch (e) {
    if (e.message.includes("duplicate column")) console.log("   -> warning_label_style already exists.");
    else console.log("   -> warning_label_style error:", e.message);
  }

  console.log("\n2. Verifying the schema...");
  const schema = await query("PRAGMA table_info(posts)");
  console.log("   Posts columns:", schema.rows.map(r => r.name).join(", "));

  console.log("\n3. Pushing the fix to GitHub...");
  const { execSync } = require("child_process");
  execSync("git add -A && git commit -m 'fix: add warning_label columns to posts table' && git push origin main", { stdio: "inherit" });

  console.log("\n==============================================");
  console.log("DONE. WAIT 2 MINUTES FOR RENDER TO DEPLOY.");
  console.log("==============================================");
  process.exit(0);
})();
