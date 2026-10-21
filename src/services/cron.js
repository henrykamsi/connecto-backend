const { query, run } = require("../db");

function startCronJobs() {
  console.log("[CRON] Background jobs started.");
  
  // Run every minute
  setInterval(async () => {
    try {
      // 1. Publish Scheduled Posts
      const scheduled = await query("SELECT id FROM posts WHERE status='scheduled' AND scheduled_at <= CURRENT_TIMESTAMP");
      for (const post of scheduled.rows) {
        await run("UPDATE posts SET status='published' WHERE id=$1", [post.id]);
        console.log("[CRON] Published scheduled post:", post.id);
        // TODO: Send FCM notification here
      }

      // 2. Auto-Delete (ADMIN Assist - 24hrs no engagement)
      const oldPosts = await query(`
        SELECT p.id FROM posts p 
        WHERE p.deleted_at IS NULL 
        AND p.status='published' 
        AND p.created_at < datetime('now', '-24 hours')
        AND (SELECT COUNT(*) FROM reactions WHERE post_id=p.id) = 0
        AND (SELECT COUNT(*) FROM comments WHERE post_id=p.id) = 0
      `);
      for (const post of oldPosts.rows) {
        await run("UPDATE posts SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [post.id]);
        console.log("[CRON] Auto-deleted ghost post:", post.id);
      }
    } catch (e) {
      console.error("[CRON ERROR]", e.message);
    }
  }, 60000); // 60 seconds
}

module.exports = { startCronJobs };
