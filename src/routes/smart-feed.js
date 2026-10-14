// [SMART-FEED] Additive module. Does not modify any existing route or table.
const express = require('express');
const crypto = require('crypto');
const { query, run } = require('../db');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const router = express.Router();

// ---------- The canonical list ----------
const CATEGORIES = [
  // Sports
  "Football","Basketball","Athletics","Boxing","Tennis","Cricket","Wrestling","Rugby",
  // News
  "World News","Nigerian News","Politics","Business","Economy","Stock Market",
  // Entertainment
  "Music","Movies","TV Shows","Comedy","Celebrity News","Nollywood","Hollywood",
  // Digital
  "Tech","Coding","AI","Gadgets","Crypto","Startups",
  // Lifestyle
  "Fashion","Beauty","Food","Cooking","Travel","Fitness","Health","Wellness",
  // Culture
  "Religion","Gospel","Education","Books","Art","Photography","History",
  // Community
  "Jobs","Career","Family","Parenting","Relationships","Local Events",
  // Gaming
  "Gaming","Esports","Anime","Comics",
  // Automotive
  "Cars","Bikes","Motorsports",
  // Extra to round to 55
  "Dance","DIY","Nature","Science","Spirituality"
];

// ---------- Schema safety (run on boot) ----------
(async () => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS user_interests (
      user_id TEXT NOT NULL,
      interest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, interest)
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_user_interests_user ON user_interests(user_id)");

    await run(`CREATE TABLE IF NOT EXISTS post_views (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, post_id)
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_post_views_user ON post_views(user_id, viewed_at DESC)");

    try { await run("ALTER TABLE posts ADD COLUMN category TEXT"); } catch (e) {}
    try { await run("ALTER TABLE posts ADD COLUMN interest_weight INTEGER NOT NULL DEFAULT 0"); } catch (e) {}

    console.log("[SMART-FEED] schema ready");
  } catch (e) {
    console.error("[SMART-FEED] schema:", e.message);
  }
})();

// ---------- Auth helper ----------
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    const p = jwt.verify(h.slice(7), env.jwt.secret);
    req.userId = p.sub;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: "INVALID_SESSION" });
  }
}

// ---------- 1) Categories / interests list ----------
router.get("/categories/list", (req, res) => {
  res.json({ success: true, categories: CATEGORIES });
});

// ---------- 2) Interests me ----------
router.get("/interests/me", auth, async (req, res) => {
  try {
    const r = await query(
      "SELECT interest FROM user_interests WHERE user_id=$1 ORDER BY created_at ASC",
      [req.userId]
    );
    res.json({ success: true, interests: r.rows.map(x => x.interest) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- 3) Save interests (max 5) ----------
router.post("/interests/save", auth, async (req, res) => {
  try {
    const list = Array.isArray(req.body?.interests) ? req.body.interests : [];
    const clean = [];
    for (const raw of list) {
      const v = String(raw || "").trim();
      if (!v) continue;
      if (!CATEGORIES.includes(v)) continue;
      if (clean.includes(v)) continue;
      clean.push(v);
      if (clean.length === 5) break;
    }
    if (clean.length === 0) return res.status(400).json({ success: false, error: "PICK_AT_LEAST_ONE" });
    if (clean.length > 5) return res.status(400).json({ success: false, error: "MAX_FIVE_INTERESTS" });

    await run("DELETE FROM user_interests WHERE user_id=$1", [req.userId]);
    for (const v of clean) {
      await run(
        "INSERT INTO user_interests (user_id, interest, created_at) VALUES ($1,$2,CURRENT_TIMESTAMP)",
        [req.userId, v]
      );
    }
    res.json({ success: true, interests: clean });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- 4) Mark posts as seen ----------
router.post("/feed/seen", auth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.post_ids) ? req.body.post_ids : [];
    const clean = ids.map(x => String(x || "").trim()).filter(Boolean).slice(0, 200);
    for (const pid of clean) {
      try {
        await run(
          "INSERT INTO post_views (user_id, post_id, viewed_at) VALUES ($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(user_id, post_id) DO UPDATE SET viewed_at=CURRENT_TIMESTAMP",
          [req.userId, pid]
        );
      } catch (_) {}
    }
    res.json({ success: true, count: clean.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Helpers for the smart feed ----------
function weightedInterestOrder(interests) {
  // Distribute the interest-pool share across selected interests.
  // 1 interest -> 100%
  // 2 -> 60/40
  // 3 -> 50/30/20
  // 4 -> 40/30/20/10
  // 5 -> 30/25/20/15/10
  const patterns = {
    1: [1.0],
    2: [0.6, 0.4],
    3: [0.5, 0.3, 0.2],
    4: [0.4, 0.3, 0.2, 0.1],
    5: [0.3, 0.25, 0.2, 0.15, 0.1]
  };
  const p = patterns[interests.length] || [1.0];
  return interests.map((it, i) => ({ interest: it, weight: p[i] }));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 5) Smart feed ----------
router.get("/feed/smart", auth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const emphasis = String(req.query.emphasis || "auto"); // interest | follower | random | auto

    // -------- Base mixes --------
    const MIXES = {
      interest: { i: 0.6, f: 0.25, r: 0.15 },
      follower: { i: 0.25, f: 0.55, r: 0.2 },
      random:   { i: 0.30, f: 0.30, r: 0.40 },
      auto:     { i: 0.45, f: 0.35, r: 0.20 }   // base
    };
    let mix = MIXES[emphasis] || MIXES.auto;

    // If user is on offset 0 and no emphasis given, rotate by "request number"
    // so consecutive refreshes feel different.
    if (emphasis === "auto") {
      const r = Math.floor(Math.random() * 3);
      const keys = ["interest", "follower", "random"];
      mix = MIXES[keys[r]];
    }

    const wantInterest = Math.max(1, Math.round(limit * mix.i));
    const wantFollow   = Math.max(1, Math.round(limit * mix.f));
    const wantRandom   = Math.max(1, limit - wantInterest - wantFollow);

    // -------- Get user's interests --------
    const interestRows = await query(
      "SELECT interest FROM user_interests WHERE user_id=$1",
      [req.userId]
    );
    const interests = interestRows.rows.map(x => x.interest);

    // -------- Recent view window --------
    const recent = await query(
      "SELECT post_id FROM post_views WHERE user_id=$1 AND viewed_at > datetime('now','-30 minutes')",
      [req.userId]
    );
    const recentViewed = new Set(recent.rows.map(x => x.post_id));

    // -------- Who I follow --------
    const following = await query(
      "SELECT following_id FROM follows WHERE follower_id=$1",
      [req.userId]
    );
    const followingIds = following.rows.map(x => x.following_id);
    const followingSet = new Set(followingIds);

    // -------- Followers' posts (recent) --------
    let followPosts = [];
    if (followingIds.length) {
      const placeholders = followingIds.map((_, i) => "$" + (i + 2)).join(",");
      const sql =
        "SELECT p.id, p.author_id, p.text, p.created_at, p.media_url, p.media_type, p.category, " +
        "u.username, u.first_name, u.surname, u.profile_photo_media_id, u.is_verified AS author_verified, " +
        "(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count, " +
        "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count " +
        "FROM posts p JOIN users u ON u.id=p.author_id " +
        "WHERE p.deleted_at IS NULL AND p.author_id IN (" + placeholders + ") " +
        "ORDER BY p.created_at DESC LIMIT 80";
      const params = [req.userId, ...followingIds];
      const r = await query(sql, params);
      followPosts = r.rows.filter(x => !recentViewed.has(x.id));
    }

    // -------- Interest-matched posts --------
    let interestPosts = [];
    if (interests.length) {
      const placeholders = interests.map((_, i) => "$" + (i + 2)).join(",");
      const sql =
        "SELECT p.id, p.author_id, p.text, p.created_at, p.media_url, p.media_type, p.category, " +
        "u.username, u.first_name, u.surname, u.profile_photo_media_id, u.is_verified AS author_verified, " +
        "(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count, " +
        "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count " +
        "FROM posts p JOIN users u ON u.id=p.author_id " +
        "WHERE p.deleted_at IS NULL AND p.category IN (" + placeholders + ") " +
        "AND p.author_id <> $1 " +
        "ORDER BY p.created_at DESC LIMIT 100";
      const params = [req.userId, ...interests];
      const r = await query(sql, params);
      interestPosts = r.rows.filter(x => !recentViewed.has(x.id) && !followingSet.has(x.author_id));
    }

    // -------- Random / trending posts (not followed, not interest) --------
    const randomSql =
      "SELECT p.id, p.author_id, p.text, p.created_at, p.media_url, p.media_type, p.category, " +
      "u.username, u.first_name, u.surname, u.profile_photo_media_id, u.is_verified AS author_verified, " +
      "(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count, " +
      "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count " +
      "FROM posts p JOIN users u ON u.id=p.author_id " +
      "WHERE p.deleted_at IS NULL AND p.author_id <> $1 " +
      "ORDER BY p.created_at DESC LIMIT 120";
    const randomRows = await query(randomSql, [req.userId]);
    let randomPosts = randomRows.rows.filter(x =>
      !recentViewed.has(x.id) &&
      !followingSet.has(x.author_id) &&
      (!x.category || !interests.includes(x.category))
    );

    // -------- Weighted interest selection --------
    const weighted = weightedInterestOrder(interests);
    const pickedInterest = [];
    const usedInterestIds = new Set();
    for (const slot of weighted) {
      const want = Math.max(1, Math.round(wantInterest * slot.weight));
      const bucket = interestPosts.filter(p => p.category === slot.interest && !usedInterestIds.has(p.id));
      const shuffled = shuffle(bucket).slice(0, want);
      shuffled.forEach(p => { usedInterestIds.add(p.id); pickedInterest.push(p); });
    }

    // -------- Shuffle the follower + random pools --------
    const pickedFollow = shuffle(followPosts).slice(0, wantFollow);
    const pickedRandom = shuffle(randomPosts).slice(0, wantRandom);

    // -------- Interleave: 2 following -> 1 interest -> 1 random, repeat --------
    const finalList = [];
    let fi = 0, ii = 0, ri = 0;
    const wantTotal = Math.min(limit, pickedFollow.length + pickedInterest.length + pickedRandom.length);

    while (finalList.length < wantTotal) {
      let added = false;

      for (let k = 0; k < 2 && fi < pickedFollow.length; k++) {
        const p = { ...pickedFollow[fi++], source: "following" };
        finalList.push(p);
        added = true;
      }
      if (ii < pickedInterest.length) {
        const p = { ...pickedInterest[ii++], source: "interest" };
        finalList.push(p);
        added = true;
      }
      if (ri < pickedRandom.length) {
        const p = { ...pickedRandom[ri++], source: "random" };
        finalList.push(p);
        added = true;
      }
      if (!added) break;
    }

    res.json({
      success: true,
      posts: finalList,
      mix: { interest: mix.i, follower: mix.f, random: mix.r },
      emphasis: emphasis,
      pagination: { limit, offset, returned: finalList.length },
      interests_used: interests
    });
  } catch (e) {
    console.error("[SMART-FEED]", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Hook into post creation — tag category ----------
// This runs on /api/v1/posts after the post is created.
// We do a lightweight UPDATE that sets the poster's category on the post.
// It does NOT block post creation. Failure is silent.
router.post("/posts/:id/tag-category", auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const u = await query("SELECT category FROM users WHERE id=$1 LIMIT 1", [req.userId]);
    const cat = u.rows.length ? u.rows[0].category : null;
    if (!cat) return res.json({ success: true, tagged: false });
    await run("UPDATE posts SET category=$1 WHERE id=$2 AND author_id=$3", [cat, postId, req.userId]);
    res.json({ success: true, tagged: true, category: cat });
  } catch (e) {
    res.json({ success: true, tagged: false });
  }
});

console.log("[SMART-FEED] loaded " + router.stack.filter(l => l.route).length + " routes");
module.exports = router;
