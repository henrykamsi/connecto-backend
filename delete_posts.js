require("dotenv").config();
const { query, run } = require("./src/db");

(async () => {
  try {
    console.log("Looking for test posts to delete...");
    
    // We completely delete the posts instead of just soft-deleting them 
    // so they don't show up anywhere in the feed or profiles.
    const posts = await query("SELECT id FROM posts");
    console.log(`Found ${posts.rows.length} total posts.`);

    // Delete attached media records first to avoid foreign key errors
    await run("DELETE FROM media WHERE post_id IS NOT NULL");
    console.log("Deleted attached media records.");

    // Delete the posts
    const result = await run("DELETE FROM posts");
    console.log(`Successfully deleted ${result.rowsAffected} posts from the database.`);

    console.log("Database is now clean. Create a fresh post in the app to test!");
    process.exit(0);
  } catch (e) {
    console.error("ERROR deleting posts:", e.message);
    process.exit(1);
  }
})();
