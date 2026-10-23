require('dotenv').config();
const { query, run } = require('./src/db');

const email = "henryglobaltechs@gmail.com";

(async () => {
  try {
    console.log("Searching for user:", email);
    
    // Find the user
    const user = await query("SELECT id, username, email_verified, is_verified, is_owner FROM users WHERE lower(email)=lower($1) LIMIT 1", [email]);
    
    if (user.rows.length === 0) {
      console.log("❌ User not found.");
      
      // Let's show the first 5 users to see what emails exist
      const all = await query("SELECT email FROM users LIMIT 5");
      console.log("Here are the first 5 emails in the DB:");
      all.rows.forEach(u => console.log("  -", u.email));
      
      process.exit(1);
    }

    console.log("✅ User found:", user.rows[0].username);
    console.log("Current status -> Verified:", user.rows[0].email_verified, "| Blue Check:", user.rows[0].is_verified, "| Owner:", user.rows[0].is_owner);
    
    // Force verify and make owner
    await run("UPDATE users SET email_verified=1, is_verified=1, is_owner=1, updated_at=CURRENT_TIMESTAMP WHERE id=$1", [user.rows[0].id]);
    
    const check = await query("SELECT email_verified, is_verified, is_owner FROM users WHERE id=$1 LIMIT 1", [user.rows[0].id]);
    console.log("\n👑 Update complete!");
    console.log("New status -> Verified:", check.rows[0].email_verified, "| Blue Check:", check.rows[0].is_verified, "| Owner:", check.rows[0].is_owner);
    
  } catch (e) {
    console.error("DB ERROR:", e.message);
  }
  process.exit(0);
})();
