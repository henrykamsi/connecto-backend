const fs = require('fs');
const { execSync } = require('child_process');

// 1. Patch server.js to ensure schema for stories and pins
const srvFile = 'server.js';
let srv = fs.readFileSync(srvFile, 'utf8');

if (!srv.includes('/* [STORIES-AND-PINS] */')) {
  const patch = `
/* [STORIES-AND-PINS] */
(async () => {
  try {
    const { run } = require("./src/db");
    await run("CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, user_id TEXT, media_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    await run("CREATE TABLE IF NOT EXISTS pinned_posts (id TEXT PRIMARY KEY, user_id TEXT, post_id TEXT, pinned_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, post_id))");
    console.log("[STORIES-AND-PINS] Tables ready.");
  } catch(e) { console.error(e.message); }
})();
`;
  srv = srv.replace('app.use(express.json(', patch + '\napp.use(express.json(');
  fs.writeFileSync(srvFile, srv);
}

// 2. Patch complete-v1.js to handle Pinning limits
const cvFile = 'src/routes/complete-v1.js';
let cv = fs.readFileSync(cvFile, 'utf8');

if (!cv.includes('/* [PIN-LIMIT-FIX] */')) {
  const pinFix = `
/* [PIN-LIMIT-FIX] */
router.post('/posts/:id/pin', auth, async (req, res, next) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    
    // Check if already pinned
    const existing = await query("SELECT id FROM pinned_posts WHERE user_id=$1 AND post_id=$2", [userId, postId]);
    if (existing.rows.length) return res.json({ success: true, pinned: true });

    // Check limit (max 2)
    const count = await query("SELECT COUNT(*) AS c FROM pinned_posts WHERE user_id=$1", [userId]);
    if (Number(count.rows[0].c) >= 2) {
      return res.status(400).json({ success: false, error: "MAX_PINS_REACHED", message: "You can only pin 2 posts. Unpin one first." });
    }

    const { v4: uuidv4 } = require('uuid');
    await query("INSERT INTO pinned_posts (id, user_id, post_id) VALUES ($1,$2,$3)", [uuidv4(), userId, postId]);
    await query("UPDATE users SET pinned_post_id=$1 WHERE id=$2", [postId, userId]); // Legacy fallback
    
    res.json({ success: true, pinned: true });
  } catch (err) { next(err); }
});

router.delete('/posts/:id/pin', auth, async (req, res, next) => {
  try {
    await query("DELETE FROM pinned_posts WHERE user_id=$1 AND post_id=$2", [req.user.id, req.params.id]);
    res.json({ success: true, unpinned: true });
  } catch (err) { next(err); }
});
`;

  // Insert the new logic before the old pin endpoint so it takes priority
  cv = cv.replace("router.post('/posts/:id/pin',", pinFix + "\nrouter.post('/posts/:id/pin_legacy',");
  cv = cv.replace("router.delete('/posts/:id/pin',", "router.delete('/posts/:id/pin_legacy',");
  fs.writeFileSync(cvFile, cv);
}

try {
  execSync('node --check server.js', { stdio: 'pipe' });
  execSync('node --check src/routes/complete-v1.js', { stdio: 'pipe' });
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
}
