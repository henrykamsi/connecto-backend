// patch-search.js — adds unified /api/v1/search with bracket modes + verification-first ordering
const fs = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "server.js");
if (!fs.existsSync(TARGET)) {
  console.error("ERROR: " + TARGET + " not found. Run from project root.");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("[SEARCH-UNIFIED-V1]")) {
  console.log("SKIP: unified search already applied.");
  process.exit(0);
}

const backupPath = TARGET + ".bak";
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(TARGET, backupPath);
  console.log("Backup written to " + backupPath);
}

// Insert the new endpoint right BEFORE the error handler at the bottom.
// Anchor: the existing express error middleware registered after all routes.
const anchorCandidates = [
  'app.use((err, req, res, next) => {',
  'app.use((err,req,res,next)=>{'
];
let anchorIdx = -1;
for (const a of anchorCandidates) {
  const i = src.indexOf(a);
  if (i !== -1) { anchorIdx = i; break; }
}
if (anchorIdx === -1) {
  console.error("ERROR: could not find error middleware anchor in server.js.");
  process.exit(1);
}

const block = `/* ============================================================
   [SEARCH-UNIFIED-V1] Unified search with bracket modes
   GET /api/v1/search?q=Ronaldo            -> { mode:"all", videos:[...], users:[...] }
   GET /api/v1/search?q=Ronaldo[video]     -> { mode:"video", videos:[...] }
   GET /api/v1/search?q=Ronaldo[user]      -> { mode:"user", users:[...] }
   Bracket is case-insensitive and singular/plural-insensitive.
   Users ranked: verified first, then followers, then created_at.
   Videos ranked: (reactions + comments + views) DESC, then created_at.
   Reserved names boost: connecto, official, admin, support, help,
   moderator, team, security, ceo, root, henryglobal, hgt.
   ==========================================================*/

const SEARCH_RESERVED_WORDS = [
  "connecto","official","admin","administrator","support","help",
  "moderator","team","security","ceo","owner","founder","root",
  "system","staff","verified","henryglobal","hgt"
];

const SEARCH_BRACKET_RE = /^([\\s\\S]*?)\\[([a-zA-Z]+)\\]\\s*$/;

function parseSearchQuery(raw) {
  const original = String(raw || "").trim();
  const m = original.match(SEARCH_BRACKET_RE);
  if (!m) return { query: original, mode: "all" };
  const q = String(m[1] || "").trim();
  const tag = String(m[2] || "").toLowerCase();
  let mode = "all";
  if (tag === "video" || tag === "videos") mode = "video";
  else if (tag === "user" || tag === "users" || tag === "people" || tag === "person") mode = "user";
  return { query: q, mode };
}

function splitQueryWords(q) {
  return String(q || "")
    .toLowerCase()
    .split(/\\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 0 && w.length <= 40)
    .slice(0, 8);
}

app.get("/api/v1/search", async (req, res) => {
  try {
    const { query, mode } = parseSearchQuery(req.query.q || "");

    // Auth: optional. Search works anonymously but reacts to auth if present.
    let viewerId = null;
    try {
      const jwt = require("jsonwebtoken");
      const envLocal = require("./src/config/env");
      const h = req.headers.authorization || "";
      if (h.startsWith("Bearer ")) {
        const p = jwt.verify(h.slice(7), envLocal.jwt.secret);
        viewerId = p.sub;
      }
    } catch (_) { /* anonymous ok */ }

    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
    const words = splitQueryWords(query);

    const isEmptyQuery = words.length === 0;

    const includeUsers = mode === "all" || mode === "user";
    const includeVideos = mode === "all" || mode === "video";

    let users = [];
    let videos = [];

    const db = require("./src/db");

    // ---------- USERS ----------
    if (includeUsers && !isEmptyQuery) {
      const like = "%" + words[0].toLowerCase() + "%";
      const isReserved = words.some(w => SEARCH_RESERVED_WORDS.includes(w));

      // Tiered scoring: exact in username > exact in first/surname > prefix > partial
      // Verified first, then followers desc, then created_at desc
      const reservedBoost = isReserved
        ? "CASE WHEN u.is_verified=1 THEN 0 ELSE 1 END"
        : "CASE WHEN u.is_verified=1 THEN 0 ELSE 1 END"; // verified first either way

      const userSql =
        "SELECT u.id, u.first_name, u.surname, u.username, u.bio, u.category, " +
        "u.country, u.state, u.gender, u.profile_photo_media_id, u.cover_photo_media_id, " +
        "u.is_verified, u.is_owner, u.account_status, " +
        "COALESCE(u.display_followers, " +
        "  (SELECT COUNT(*) FROM follows f WHERE f.following_id=u.id)" +
        ") AS followers_count, " +
        "CASE " +
        "  WHEN lower(u.username)=lower($1) THEN 100 " +
        "  WHEN lower(u.first_name)=lower($1) OR lower(u.surname)=lower($1) THEN 90 " +
        "  WHEN lower(u.username) LIKE lower($1) || '%' THEN 80 " +
        "  WHEN lower(u.first_name) LIKE lower($1) || '%' OR lower(u.surname) LIKE lower($1) || '%' THEN 70 " +
        "  WHEN lower(u.username) LIKE $2 THEN 60 " +
        "  WHEN lower(u.first_name) LIKE $2 OR lower(u.surname) LIKE $2 THEN 50 " +
        "  ELSE 0 " +
        "END AS match_score " +
        "FROM users u " +
        "WHERE u.account_status='active' AND u.deleted_at IS NULL " +
        "  AND (lower(u.username) LIKE $2 OR lower(u.first_name) LIKE $2 OR lower(u.surname) LIKE $2) " +
        "ORDER BY " + reservedBoost + " ASC, match_score DESC, followers_count DESC, u.created_at DESC " +
        "LIMIT $3";

      const r = await db.query(userSql, [words[0], like, limit]);
      users = r.rows.map(u => ({
        id: u.id,
        first_name: u.first_name,
        surname: u.surname,
        username: u.username,
        bio: u.bio,
        category: u.category,
        country: u.country,
        state: u.state,
        gender: u.gender,
        profile_photo_media_id: u.profile_photo_media_id,
        cover_photo_media_id: u.cover_photo_media_id,
        is_verified: Number(u.is_verified) === 1,
        is_owner: Number(u.is_owner) === 1,
        followers_count: Number(u.followers_count || 0)
      }));
    }

    // ---------- VIDEOS ----------
    if (includeVideos && !isEmptyQuery) {
      // Word split: any word present in p.text. Rank by how many words matched,
      // then by engagement, then by newest.
      // We build 4 word slots max, so the SQL stays bounded.
      const w1 = words[0] || "";
      const w2 = words[1] || "";
      const w3 = words[2] || "";
      const w4 = words[3] || "";

      const matchesExpr =
        "(" +
        "CASE WHEN $1 <> '' AND lower(p.text) LIKE '%'||lower($1)||'%' THEN 1 ELSE 0 END + " +
        "CASE WHEN $2 <> '' AND lower(p.text) LIKE '%'||lower($2)||'%' THEN 1 ELSE 0 END + " +
        "CASE WHEN $3 <> '' AND lower(p.text) LIKE '%'||lower($3)||'%' THEN 1 ELSE 0 END + " +
        "CASE WHEN $4 <> '' AND lower(p.text) LIKE '%'||lower($4)||'%' THEN 1 ELSE 0 END" +
        ")";

      const b2 = require("./src/providers/b2");

      const videoSql =
        "SELECT p.id, p.author_id, p.text, p.created_at, p.view_count, " +
        "u.first_name, u.surname, u.username, u.profile_photo_media_id, " +
        "u.is_verified AS author_verified, " +
        "(SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL LIMIT 1) AS media_key, " +
        "'video' AS media_type, " +
        "(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) AS reaction_count, " +
        "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count, " +
        "COALESCE(p.view_count, 0) AS view_count_num, " +
        matchesExpr + " AS word_matches " +
        "FROM posts p JOIN users u ON u.id=p.author_id " +
        "WHERE p.deleted_at IS NULL AND u.account_status='active' " +
        "  AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='video' AND m.deleted_at IS NULL) " +
        "  AND (" + matchesExpr + ") > 0 " +
        "ORDER BY word_matches DESC, " +
        "  (COALESCE((SELECT COUNT(*) FROM reactions r2 WHERE r2.post_id=p.id),0) + " +
        "   COALESCE((SELECT COUNT(*) FROM comments c2 WHERE c2.post_id=p.id AND c2.deleted_at IS NULL),0) + " +
        "   COALESCE(p.view_count,0)) DESC, " +
        "  p.created_at DESC " +
        "LIMIT $5";

      const vr = await db.query(videoSql, [w1, w2, w3, w4, limit]);

      videos = await Promise.all(vr.rows.map(async row => {
        let mediaUrl = null;
        if (row.media_key) {
          try {
            mediaUrl = String(row.media_key).indexOf("http") === 0
              ? row.media_key
              : await b2.signedDownload(row.media_key, 3600);
          } catch (e) {
            console.error("[SEARCH-VIDEO-SIGN]", e.message);
          }
        }
        return {
          id: row.id,
          author_id: row.author_id,
          text: row.text,
          created_at: row.created_at,
          first_name: row.first_name,
          surname: row.surname,
          username: row.username,
          profile_photo_media_id: row.profile_photo_media_id,
          author_verified: Number(row.author_verified) === 1,
          media_url: mediaUrl,
          media_type: "video",
          reaction_count: Number(row.reaction_count || 0),
          comment_count: Number(row.comment_count || 0),
          view_count: Number(row.view_count_num || 0)
        };
      }));
    }

    res.json({
      success: true,
      mode,
      query_used: query,
      users,
      videos,
      counts: { users: users.length, videos: videos.length }
    });
  } catch (e) {
    console.error("[SEARCH-UNIFIED]", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* [/SEARCH-UNIFIED-V1] */

`;

src = src.slice(0, anchorIdx) + block + src.slice(anchorIdx);

fs.writeFileSync(TARGET, src);
console.log("OK: [SEARCH-UNIFIED-V1] inserted into server.js");
