
const express = require("express");
const router = express.Router();
const { query, run } = require("./src/db");
const jwt = require("jsonwebtoken");
const envLocal = require("./src/config/env");
const crypto = require("crypto");

// 1. DATABASE SETUP
(async () => {
  try {
    // Add fingerprint and copycat columns to posts
    try { await run("ALTER TABLE posts ADD COLUMN video_fingerprint TEXT"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN is_copycat INTEGER DEFAULT 0"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN original_post_id TEXT"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN viral_boost_score INTEGER DEFAULT 0"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN last_boost_at TEXT"); } catch (e) {}
    
    // Track views for analytics
    await run("CREATE TABLE IF NOT EXISTS post_views (id TEXT PRIMARY KEY, post_id TEXT, user_id TEXT, country TEXT, gender TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    
    // Track user streaks
    await run("CREATE TABLE IF NOT EXISTS user_streaks (user_id TEXT PRIMARY KEY, post_streak INTEGER DEFAULT 0, last_post_date TEXT, viral_waiting_room_entered INTEGER DEFAULT 0)");
    
    console.log("[ALGORITHM] Schema ready");
  } catch (e) { console.error("[ALGORITHM] Schema error:", e.message); }
})();

// 2. FINGERPRINTING (How we catch copycats)
function generateFingerprint(text, mediaUrl) {
  // In production, we would hash 3 frames of the video. 
  // For now, we hash the text + the first 100 chars of the media URL.
  const raw = (text || "") + (mediaUrl || "").substring(0, 100);
  return crypto.createHash("md5").update(raw).digest("hex");
}

// 3. COPYRIGHT LOGIC (40/60 Split)
router.post("/algorithm/check-copyright", async (req, res) => {
  try {
    const { text, mediaUrl, postId } = req.body;
    const fingerprint = generateFingerprint(text, mediaUrl);
    
    // Check if this fingerprint already exists
    const existing = await query("SELECT id, author_id FROM posts WHERE video_fingerprint=$1 AND deleted_at IS NULL LIMIT 1", [fingerprint]);
    
    if (existing.rows.length) {
      const original = existing.rows[0];
      
      // Mark the new post as a copycat and link it to the original
      await run("UPDATE posts SET is_copycat=1, original_post_id=$1, video_fingerprint=$2 WHERE id=$3", [original.id, fingerprint, postId]);
      
      // 40/60 Split Logic: Give the original creator an artificial boost
      await run("UPDATE posts SET viral_boost_score = viral_boost_score + 20 WHERE id=$1", [original.id]);
      
      return res.json({ isCopycat: true, originalPostId: original.id, originalAuthorId: original.author_id, fingerprint });
    }
    
    // If it's original, save the fingerprint
    await run("UPDATE posts SET video_fingerprint=$1 WHERE id=$2", [fingerprint, postId]);
    res.json({ isCopycat: false, fingerprint });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. THE 4-STEP VIRAL LOOP (Cron Job Simulation)
router.get("/algorithm/run-viral-loop", async (req, res) => {
  try {
    // Get all posts from the last 48 hours that are not deleted
    const posts = await query("SELECT id, is_copycat, viral_boost_score, created_at FROM posts WHERE deleted_at IS NULL AND created_at > datetime('now', '-2 days')");
    
    for (const post of posts.rows) {
      const id = post.id;
      const isCopycat = post.is_copycat === 1;
      const currentScore = post.viral_boost_score;
      
      // Calculate age in minutes
      const ageMins = Math.floor((new Date() - new Date(post.created_at)) / 60000);
      
      // Get metrics
      const likes = (await query("SELECT COUNT(*) AS c FROM reactions WHERE post_id=$1", [id])).rows[0].c;
      const comments = (await query("SELECT COUNT(*) AS c FROM comments WHERE post_id=$1 AND deleted_at IS NULL", [id])).rows[0].c;
      const views = (await query("SELECT COUNT(*) AS c FROM post_views WHERE post_id=$1", [id])).rows[0].c;
      
      let newScore = currentScore;
      
      // STEP 1: The Spark (15 mins, 10 likes, 2 comments)
      if (ageMins > 15 && currentScore === 0 && likes >= 10 && comments >= 2) {
        newScore = 20;
      }
      // STEP 2: The Fire (30 mins, 50 likes, 10 comments)
      else if (ageMins > 30 && currentScore === 20 && likes >= 50 && comments >= 10) {
        newScore = 40;
      }
      // STEP 3: The Surge (1 hour, 150 likes, 30 comments)
      else if (ageMins > 60 && currentScore === 40 && likes >= 150 && comments >= 30) {
        newScore = 60;
      }
      // STEP 4: The Viral (2 hours, 500 likes, 100 comments)
      else if (ageMins > 120 && currentScore === 60 && likes >= 500 && comments >= 100) {
        newScore = 100;
      }
      
      // Anti-Gaming: If Copycat, cap at 60
      if (isCopycat && newScore > 60) {
        newScore = 60; 
      }
      
      if (newScore > currentScore) {
        await run("UPDATE posts SET viral_boost_score=$1, last_boost_at=CURRENT_TIMESTAMP WHERE id=$2", [newScore, id]);
      }
    }
    res.json({ success: true, processed: posts.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. THE CATEGORY FEED (Hybrid Logic)
router.get("/feed/viral-hybrid", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let me = null;
    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const limit = 20;
    const offset = Number(req.query.offset || 0);

    // Fetch user's interests
    const intRows = await query("SELECT interest FROM user_interests WHERE user_id=$1", [me]);
    const interests = intRows.rows.map(r => r.interest);
    
    // Fetch followed accounts
    const folRows = await query("SELECT following_id FROM follows WHERE follower_id=$1", [me]);
    const followingIds = folRows.rows.map(r => r.following_id);
    const followingList = followingIds.length ? followingIds.map(id => `'${id}'`).join(",") : "'none'";

    // 1. Fetch posts matching the user's interests (80% of feed)
    let categoryFilter = "";
    if (interests.length > 0) {
       categoryFilter = `AND p.category IN (${interests.map(i => `'${i}'`).join(",")})`;
    }

    const interestPosts = await query(`
      SELECT p.*, u.first_name, u.surname, u.username, u.profile_photo_media_id, 
             (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count
      FROM posts p JOIN users u ON u.id=p.author_id
      WHERE p.deleted_at IS NULL AND p.audience='public' ${categoryFilter}
      ORDER BY p.viral_boost_score DESC, p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    // 2. Fetch random viral posts for the 20% discovery
    const viralPosts = await query(`
      SELECT p.*, u.first_name, u.surname, u.username, u.profile_photo_media_id,
             (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count
      FROM posts p JOIN users u ON u.id=p.author_id
      WHERE p.deleted_at IS NULL AND p.audience='public' AND p.viral_boost_score >= 60
      ORDER BY RANDOM() LIMIT 4
    `);

    // Merge and remove duplicates
    const seen = new Set();
    const finalFeed = [];
    
    // Add some interest posts
    for (const p of interestPosts.rows) {
      if (!seen.has(p.id)) { seen.add(p.id); finalFeed.push(p); }
      if (finalFeed.length >= 16) break; // 80%
    }
    
    // Add viral posts
    for (const p of viralPosts.rows) {
      if (!seen.has(p.id)) { seen.add(p.id); finalFeed.push(p); }
      if (finalFeed.length >= limit) break; // 20%
    }

    res.json({ success: true, posts: finalFeed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. POST ANALYSIS (The new endpoint)
router.get("/posts/:id/analysis-hub", async (req, res) => {
  try {
    const postId = req.params.id;
    
    // Get the post info
    const p = await query("SELECT is_copycat, original_post_id, viral_boost_score FROM posts WHERE id=$1 LIMIT 1", [postId]);
    if (!p.rows.length) return res.status(404).json({ error: "Not found" });
    const post = p.rows[0];
    
    // View stats
    const todayViews = (await query("SELECT COUNT(*) AS c FROM post_views WHERE post_id=$1 AND date(created_at)=date('now')", [postId])).rows[0].c;
    const last7Views = (await query("SELECT COUNT(*) AS c FROM post_views WHERE post_id=$1 AND created_at > datetime('now','-7 days')", [postId])).rows[0].c;
    const last30Views = (await query("SELECT COUNT(*) AS c FROM post_views WHERE post_id=$1 AND created_at > datetime('now','-30 days')", [postId])).rows[0].c;
    
    // Demographics (Country & Gender)
    const countries = await query("SELECT country, COUNT(*) as count FROM post_views WHERE post_id=$1 GROUP BY country ORDER BY count DESC LIMIT 5", [postId]);
    const genders = await query("SELECT gender, COUNT(*) as count FROM post_views WHERE post_id=$1 GROUP BY gender", [postId]);
    
    // Get original creator name if copycat
    let originalCreator = null;
    if (post.is_copycat && post.original_post_id) {
       const o = await query("SELECT u.username, u.first_name, u.surname FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1", [post.original_post_id]);
       if (o.rows.length) originalCreator = o.rows[0];
    }

    res.json({
      success: true,
      is_copycat: post.is_copycat === 1,
      viral_score: post.viral_boost_score,
      original_creator: originalCreator,
      views: { today: todayViews, last7: last7Views, last30: last30Views },
      countries: countries.rows,
      genders: genders.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
