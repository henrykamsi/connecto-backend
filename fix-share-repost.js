const fs = require('fs');
const { execSync } = require('child_process');

// 1. Patch Server DB to store original_post_id safely
const srvFile = 'server.js';
let srv = fs.readFileSync(srvFile, 'utf8');

if (!srv.includes('/* [REPOST-FIX] */')) {
  const patch = `
/* [REPOST-FIX] */
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (body) {
      if (body.post && body.post.id) {
        // If this is a repost, ensure the boolean flag is sent
        body.post.is_repost = Boolean(body.post.original_post_id);
      }
    }
    return originalJson(body);
  };
  next();
});
`;
  srv = srv.replace('app.use(express.json(', patch + '\napp.use(express.json(');
  fs.writeFileSync(srvFile, srv);
  console.log('OK: server.js patched for Repost flags.');
}

// 2. Ensure complete-v1.js properly handles repost-to-profile and repost-to-reels
const cvFile = 'src/routes/complete-v1.js';
let cv = fs.readFileSync(cvFile, 'utf8');

if (!cv.includes('/* [REPOST-ENDPOINTS] */')) {
  const repostPatch = `
/* [REPOST-ENDPOINTS] */
router.post('/posts/:id/repost-to-profile', auth, async (req, res, next) => {
  try {
    const originalId = req.params.id;
    const original = await query("SELECT id FROM posts WHERE id=$1 AND deleted_at IS NULL LIMIT 1", [originalId]);
    if (!original.rows.length) return res.status(404).json({ success: false, error: "POST_NOT_FOUND" });

    const existing = await query("SELECT id FROM posts WHERE original_post_id=$1 AND author_id=$2 AND deleted_at IS NULL LIMIT 1", [originalId, req.user.id]);
    if (existing.rows.length) return res.json({ success: true, post_id: existing.rows[0].id, alreadyReposted: true });

    const newId = uuidv4();
    await query(
      "INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, original_post_id) VALUES ($1,$2,NULL,'public',1,1,$3)",
      [newId, req.user.id, originalId]
    );

    res.status(201).json({ success: true, post_id: newId, is_repost: true });
  } catch (err) { next(err); }
});

router.post('/posts/:id/repost-to-reels', auth, async (req, res, next) => {
  try {
    const originalId = req.params.id;
    const original = await query("SELECT id FROM posts WHERE id=$1 AND deleted_at IS NULL LIMIT 1", [originalId]);
    if (!original.rows.length) return res.status(404).json({ success: false, error: "POST_NOT_FOUND" });

    const existing = await query("SELECT id FROM posts WHERE original_post_id=$1 AND author_id=$2 AND deleted_at IS NULL LIMIT 1", [originalId, req.user.id]);
    if (existing.rows.length) return res.json({ success: true, post_id: existing.rows[0].id, alreadyReposted: true });

    const newId = uuidv4();
    await query(
      "INSERT INTO posts (id, author_id, text, audience, comments_enabled, share_enabled, original_post_id) VALUES ($1,$2,NULL,'reels',1,1,$3)",
      [newId, req.user.id, originalId]
    );

    res.status(201).json({ success: true, post_id: newId, is_repost: true });
  } catch (err) { next(err); }
});
`;

  // Insert before module.exports
  cv = cv.replace("module.exports = router;", repostPatch + "\nmodule.exports = router;");
  fs.writeFileSync(cvFile, cv);
  console.log('OK: complete-v1.js patched for Repost Endpoints.');
}

// Verify syntax
try {
  execSync('node --check server.js', { stdio: 'pipe' });
  execSync('node --check src/routes/complete-v1.js', { stdio: 'pipe' });
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
}
