const express = require('express');
const { query, run } = require('../db');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const b2 = require('../providers/b2');

const router = express.Router();

const CATEGORIES = ["Football","Basketball","Athletics","Boxing","Tennis","Cricket","Wrestling","Rugby","World News","Nigerian News","Politics","Business","Economy","Stock Market","Music","Movies","TV Shows","Comedy","Celebrity News","Nollywood","Hollywood","Tech","Coding","AI","Gadgets","Crypto","Startups","Fashion","Beauty","Food","Cooking","Travel","Fitness","Health","Wellness","Religion","Gospel","Education","Books","Art","Photography","History","Jobs","Career","Family","Parenting","Relationships","Local Events","Gaming","Esports","Anime","Comics","Cars","Bikes","Motorsports","Dance","DIY","Nature","Science","Spirituality"];

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    const p = jwt.verify(h.slice(7), env.jwt.secret);
    req.userId = p.sub;
    next();
  } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
}

function shuffle(a) { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

function weighted(interests) {
  const P = { 1: [1], 2: [0.6, 0.4], 3: [0.5, 0.3, 0.2], 4: [0.4, 0.3, 0.2, 0.1], 5: [0.3, 0.25, 0.2, 0.15, 0.1] };
  const p = P[interests.length] || [1];
  return interests.map((it, i) => ({ interest: it, weight: p[i] }));
}

router.get("/categories/list", (req, res) => res.json({ success: true, categories: CATEGORIES }));

router.get("/interests/me", auth, async (req, res) => {
  try {
    const r = await query("SELECT interest FROM user_interests WHERE user_id=$1 ORDER BY created_at ASC", [req.userId]);
    res.json({ success: true, interests: r.rows.map(x => x.interest) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post("/interests/save", auth, async (req, res) => {
  try {
    const list = Array.isArray(req.body?.interests) ? req.body.interests : [];
    const clean = [];
    for (const raw of list) { const v = String(raw || "").trim(); if (!v || !CATEGORIES.includes(v) || clean.includes(v)) continue; clean.push(v); if (clean.length === 5) break; }
    if (!clean.length) return res.status(400).json({ success: false, error: "PICK_AT_LEAST_ONE" });
    await run("DELETE FROM user_interests WHERE user_id=$1", [req.userId]);
    for (const v of clean) await run("INSERT INTO user_interests (user_id, interest) VALUES ($1,$2)", [req.userId, v]);
    res.json({ success: true, interests: clean });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post("/feed/seen", auth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.post_ids) ? req.body.post_ids : [];
    const clean = ids.map(x => String(x || "").trim()).filter(Boolean).slice(0, 200);
    for (const pid of clean) { try { await run("INSERT INTO post_views (user_id, post_id) VALUES ($1,$2) ON CONFLICT(user_id, post_id) DO UPDATE SET viewed_at=CURRENT_TIMESTAMP", [req.userId, pid]); } catch (_) {} }
    res.json({ success: true, count: clean.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post("/posts/:id/tag-category", auth, async (req, res) => {
  try {
    const u = await query("SELECT category FROM users WHERE id=$1 LIMIT 1", [req.userId]);
    const cat = u.rows.length ? u.rows[0].category : null;
    if (!cat) return res.json({ success: true, tagged: false });
    await run("UPDATE posts SET category=$1 WHERE id=$2 AND author_id=$3", [cat, req.params.id, req.userId]);
    res.json({ success: true, tagged: true, category: cat });
  } catch (e) { res.json({ success: true, tagged: false }); }
});

// SQL builder that matches complete-v1.js schema (media joined via media table)
const POST_COLS = "p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.share_enabled, p.created_at, " +
  "p.category, p.is_ai_content, u.first_name, u.surname, u.username, u.profile_photo_media_id, u.is_verified AS author_verified, " +
  "(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count, " +
  "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count, " +
  "COALESCE(p.view_count, 0) AS view_count, " +
  "(SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key, " +
  "(SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type";

async function signMedia(rows) {
  return Promise.all(rows.map(async r => {
    let url = null;
    if (r.media_key) {
      try {
        url = String(r.media_key).indexOf("http") === 0 ? r.media_key : await b2.signedDownload(r.media_key, 3600);
      } catch (e) { console.error("[SMART-FEED-SIGN]", e.message); }
    }
    const { media_key, ...rest } = r;
    return { ...rest, media_url: url };
  }));
}

/* [SMART-FEED-FALLBACK-C] Three-pass feed: unique -> widened -> repeat.
   Pass 1 = original behaviour. Pass 2 = widen (drop 30-min recency, dedupe).
   Pass 3 = repeat (allow duplicates in one response) as last resort. */

const MIXES_C = {
  interest: { i: 0.60, f: 0.25, r: 0.15 },
  follower: { i: 0.25, f: 0.55, r: 0.20 },
  random:   { i: 0.30, f: 0.30, r: 0.40 },
  auto:     { i: 0.45, f: 0.35, r: 0.20 }
};

function interleaveC(pickedF, pickedI, pickedR, limit) {
  const out = [];
  let fi = 0, ii = 0, ri = 0;
  const total = Math.min(limit, pickedF.length + pickedI.length + pickedR.length);
  while (out.length < total) {
    let added = false;
    for (let k = 0; k < 2 && fi < pickedF.length; k++) {
      out.push({ ...pickedF[fi++], source: "following" });
      added = true;
    }
    if (ii < pickedI.length) { out.push({ ...pickedI[ii++], source: "interest" }); added = true; }
    if (ri < pickedR.length) { out.push({ ...pickedR[ri++], source: "random" }); added = true; }
    if (!added) break;
  }
  return out;
}

function bucketPickC(interestPosts, followPosts, randomPosts, interests, wantI, wantF, wantR) {
  const pickedI = [];
  const used = new Set();
  for (const slot of weighted(interests)) {
    const want = Math.max(1, Math.round(wantI * slot.weight));
    const bucket = interestPosts.filter(p => p.category === slot.interest && !used.has(p.id));
    const picked = shuffle(bucket).slice(0, want);
    picked.forEach(p => { used.add(p.id); pickedI.push(p); });
  }
  const pickedF = shuffle(followPosts).slice(0, wantF);
  const pickedR = shuffle(randomPosts).slice(0, wantR);
  return { pickedI, pickedF, pickedR };
}

router.get("/feed/smart", auth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
    const emphasis = String(req.query.emphasis || "auto");
    let mix = MIXES_C[emphasis] || MIXES_C.auto;
    if (emphasis === "auto") mix = MIXES_C[["interest","follower","random"][Math.floor(Math.random()*3)]];

    const wantI = Math.max(1, Math.round(limit * mix.i));
    const wantF = Math.max(1, Math.round(limit * mix.f));
    const wantR = Math.max(1, limit - wantI - wantF);

    /* [PARALLEL-READERS] Fetch setup data in parallel */
    const [intRows, rec, fol] = await Promise.all([
      query("SELECT interest FROM user_interests WHERE user_id=$1", [req.userId]),
      query("SELECT post_id FROM post_views WHERE user_id=$1 AND viewed_at > datetime('now','-30 minutes')", [req.userId]),
      query("SELECT following_id FROM follows WHERE follower_id=$1", [req.userId])
    ]);
    const interests = intRows.rows.map(x => x.interest);
    const recent = new Set(rec.rows.map(x => x.post_id));
    const followingIds = fol.rows.map(x => x.following_id);
    const followingSet = new Set(followingIds);

    async function readFollowing(excludeIds) {
      if (!followingIds.length) return [];
      const ph = followingIds.map((_, i) => "$" + (i + 1)).join(",");
      const r = await query("SELECT " + POST_COLS + " FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = \x27published\x27) AND p.author_id IN (" + ph + ") ORDER BY p.created_at DESC LIMIT 200", followingIds);
      return r.rows.filter(x => !excludeIds.has(x.id));
    }
    async function readInterest(excludeIds) {
      if (!interests.length) return [];
      const ph = interests.map((_, i) => "$" + (i + 2)).join(",");
      const r = await query("SELECT " + POST_COLS + " FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = \x27published\x27) AND p.category IN (" + ph + ") AND p.author_id <> $1 ORDER BY p.created_at DESC LIMIT 200", [req.userId, ...interests]);
      return r.rows.filter(x => !excludeIds.has(x.id) && !followingSet.has(x.author_id));
    }
    async function readRandom(excludeIds) {
      const r = await query("SELECT " + POST_COLS + " FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = \x27published\x27) AND p.author_id <> $1 ORDER BY p.created_at DESC LIMIT 200", [req.userId]);
      return r.rows.filter(x => !excludeIds.has(x.id) && !followingSet.has(x.author_id) && (!x.category || !interests.includes(x.category)));
    }

    /* [PARALLEL-READERS] Fire all 3 readers concurrently. Cuts cold-start latency 3x. */
    const [p1F, p1I, p1R] = await Promise.all([
      readFollowing(recent),
      readInterest(recent),
      readRandom(recent)
    ]);
    const b1 = bucketPickC(p1I, p1F, p1R, interests, wantI, wantF, wantR);
    let out = interleaveC(b1.pickedF, b1.pickedI, b1.pickedR, limit);

    if (out.length < limit) {
      const pickedIds = new Set(out.map(p => p.id));
      const w2F = (await readFollowing(new Set())).filter(x => !pickedIds.has(x.id));
      const w2I = (await readInterest(new Set())).filter(x => !pickedIds.has(x.id));
      const w2R = (await readRandom(new Set())).filter(x => !pickedIds.has(x.id));
      const remaining = limit - out.length;
      const b2 = bucketPickC(w2I, w2F, w2R, interests, Math.max(1, Math.round(remaining * mix.i)), Math.max(1, Math.round(remaining * mix.f)), Math.max(1, remaining));
      const fill = interleaveC(b2.pickedF, b2.pickedI, b2.pickedR, remaining).map(p => ({ ...p, source: "rewatch" }));
      out = out.concat(fill);
    }

    if (out.length < limit) {
      const [allF, allI, allR] = await Promise.all([
        readFollowing(new Set()),
        readInterest(new Set()),
        readRandom(new Set())
      ]);
      const pool = shuffle([...allF, ...allI, ...allR]);
      if (pool.length > 0) {
        let idx = 0;
        while (out.length < limit) {
          const p = pool[idx % pool.length];
          out.push({ ...p, source: "repeat" });
          idx++;
          if (idx >= pool.length * limit) break;
        }
      }
    }

    if (out.length > limit) out = out.slice(0, limit);

    const signed = await signMedia(out);
    res.json({
      success: true,
      posts: signed,
      mix,
      emphasis,
      interests_used: interests,
      passes: {
        p1: { count: b1.pickedF.length + b1.pickedI.length + b1.pickedR.length },
        total_returned: signed.length
      }
    });
  } catch (e) { console.error("[SMART-FEED]", e); res.status(500).json({ success: false, error: e.message }); }
});


console.log("[SMART-FEED] loaded " + router.stack.filter(l => l.route).length + " routes");
module.exports = router;
