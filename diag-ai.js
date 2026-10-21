require('dotenv').config();
const { query } = require('./src/db');

(async () => {
  try {
    console.log("=== 1. CHECKING RECENT POSTS IN DB ===");
    const posts = await query(
      "SELECT id, text, is_ai_content, created_at FROM posts ORDER BY created_at DESC LIMIT 3"
    );
    
    if (posts.rows.length === 0) {
      console.log("No posts found in database.");
    } else {
      posts.rows.forEach((p, i) => {
        console.log(`Post #${i + 1}:`);
        console.log(`  ID: ${p.id}`);
        console.log(`  Text: ${p.text ? p.text.slice(0, 20) : '(no text)'}`);
        console.log(`  is_ai_content IN DB: ${p.is_ai_content} (Type: ${typeof p.is_ai_content})`);
        console.log(`  Created At: ${p.created_at}`);
      });
    }
  } catch (e) {
    console.error("DB ERROR:", e.message);
  }
  process.exit(0);
})();
