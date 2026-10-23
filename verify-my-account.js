require('dotenv').config();
const { query, run } = require('./src/db');

const email = "henryglobaltechs@gmail.com"; // <--- henryglobaltechs@gmail.com

(async () => {
  try {
    console.log("Looking for user:", email);
    
    // 1. Find the user
    const user = await query("SELECT id, email_verified FROM users WHERE email=$1 LIMIT 1", [email]);
    if (user.rows.length === 0) {
      console.log("❌ User not found. Check the email spelling.");
      process.exit(1);
    }
    
    // 2. Force verify them
    await run("UPDATE users SET email_verified=1, updated_at=CURRENT_TIMESTAMP WHERE email=$1", [email]);
    
    // 3. Verify it worked
    const check = await query("SELECT email_verified FROM users WHERE email=$1 LIMIT 1", [email]);
    console.log("✅ Account verified! email_verified is now:", check.rows[0].email_verified);
    
  } catch (e) {
    console.error("DB ERROR:", e.message);
  }
  process.exit(0);
})();
