// patch-smart-feed.js — applies [SMART-FEED-FALLBACK-C] to src/routes/smart-feed.js
const fs = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "routes", "smart-feed.js");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: " + TARGET + " not found. Run from project root.");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("[SMART-FEED-FALLBACK-C]")) {
  console.log("SKIP: fallback-C already applied.");
  process.exit(0);
}

const backupPath = TARGET + ".bak";
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(TARGET, backupPath);
  console.log("Backup written to " + backupPath);
}

const startMarker = 'router.get("/feed/smart", auth, async (req, res) => {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('ERROR: could not find router.get("/feed/smart" ...) block.');
  process.exit(1);
}

let depth = 0, inString = false, inTemplate = false, inLineComment = false, inBlockComment = false, endIdx = -1;
for (let i = startIdx; i < src.length; i++) {
  const ch = src[i];
  const nxt = src[i + 1];
  if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
  if (inBlockComment) { if (ch === "*" && nxt === "/") { inBlockComment = false; i++; } continue; }
  if (inString) { if (ch === "\\") { i++; continue; } if (ch === '"') inString = false; continue; }
  if (inTemplate) { if (ch === "\\") { i++; continue; } if (ch === "`") inTemplate = false; continue; }
  if (ch === "/" && nxt === "/") { inLineComment = true; i++; continue; }
  if (ch === "/" && nxt === "*") { inBlockComment = true; i++; continue; }
  if (ch === '"') { inString = true; continue; }
  if (ch === "`") { inTemplate = true; continue; }
  if (ch === "{") { depth++; continue; }
  if (ch === "}") {
    depth--;
    if (depth === 0) {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ")") {
        j++;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ";") { endIdx = j + 1; break; }
      }
    }
  }
}
if (endIdx === -1) {
  console.error("ERROR: could not find end of /feed/smart handler.");
  process.exit(1);
}

const newHandler = `/* [SMART-FEED-FALLBACK-C] Three-pass feed: unique -> widened -> repeat.
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

    const intRows = await query("SELECT interest FROM user_interests WHERE user_id=$1", [req.userId]);
    const interests = intRows.rows.map(x => x.interest);

    const rec = await query("SELECT post_id FROM post_views WHERE user_id=$1 AND viewed_at > datetime('now','-30 minutes')", [req.userId]);
    const recent = new Set(rec.rows.map(x => x.post_id));

    const fol = await query("SELECT following_id FROM follows WHERE follower_id=$1", [req.userId]);
    const followingIds = fol.rows.map(x => x.following_id);
    const followingSet = new Set(followingIds);

    async function readFollowing(excludeIds) {
      if (!followingIds.length) return [];
      const ph = followingIds.map((_, i) => "$" + (i + 1)).join(",");
      const r = await query("SELECT " + POST_COLS + " FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND p.author_id IN (" + ph + ") ORDER BY p.created_at DESC LIMIT 200", followingIds);
      return r.rows.filter(x => !excludeIds.has(x.id));
    }
    async function readInterest(excludeIds) {
      if (!interests.length) return [];
      const ph = interests.map((_, i) => "$" + (i + 2)).join(",");
      const r = await query("SELECT " + POST_COLS + " FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND p.category IN (" + ph + ") AND p.author_id <> $1 ORDER BY p.created_at DESC LIMIT 200", [req.userId, ...interests]);
      return r.rows.filter(x => !excludeIds.has(x.id) && !followingSet.has(x.author_id));
    }
    async function readRandom(excludeIds) {
      const r = await query("SELECT " + POST_COLS + " FROM posts p JOIN users u ON u.id=p.author_id WHERE p.deleted_at IS NULL AND p.author_id <> $1 ORDER BY p.created_at DESC LIMIT 200", [req.userId]);
      return r.rows.filter(x => !excludeIds.has(x.id) && !followingSet.has(x.author_id) && (!x.category || !interests.includes(x.category)));
    }

    const p1F = await readFollowing(recent);
    const p1I = await readInterest(recent);
    const p1R = await readRandom(recent);
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
      const allF = await readFollowing(new Set());
      const allI = await readInterest(new Set());
      const allR = await readRandom(new Set());
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
`;

src = src.slice(0, startIdx) + newHandler + src.slice(endIdx);

if (!src.includes("module.exports = router;")) {
  console.error("ERROR: module.exports = router; missing after patch. Restoring backup.");
  fs.copyFileSync(backupPath, TARGET);
  process.exit(1);
}

fs.writeFileSync(TARGET, src);
console.log("OK: [SMART-FEED-FALLBACK-C] applied to src/routes/smart-feed.js");
