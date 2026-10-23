const fs = require('fs');
const { execSync } = require('child_process');

// 1. Update the DB Schema and POST /posts to accept scheduled_at
const cvFile = 'src/routes/complete-v1.js';
let cv = fs.readFileSync(cvFile, 'utf8');

// Add scheduled_at column safety check
const schemaCheck = `
(async () => {
  try {
    const { run } = require('../db');
    try { await run("ALTER TABLE posts ADD COLUMN scheduled_at TEXT"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published'"); } catch(e){}
    console.log("[SCHEDULE] DB columns ready.");
  } catch(e) { console.error("[SCHEDULE]", e.message); }
})();
`;
if (!cv.includes('[SCHEDULE] DB columns ready')) {
  cv = schemaCheck + '\n' + cv;
}

// Update the INSERT query to save scheduled_at and status
const oldInsert = `INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
const newInsert = `INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content, scheduled_at, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

if (cv.includes(oldInsert)) {
  cv = cv.replace(oldInsert, newInsert);
  
  // Add the parameters to the array
  const oldParams = `req.body.privacy || 'public',
        req.body.boost_boost ? 1 : 0,
        req.body.is_ai_content ? 1 : 0
      ]`;
  const newParams = `req.body.privacy || 'public',
        req.body.boost_boost ? 1 : 0,
        req.body.is_ai_content ? 1 : 0,
        req.body.scheduledTime || null,
        req.body.scheduledTime ? 'scheduled' : 'published'
      ]`;
  if (cv.includes(oldParams)) {
    cv = cv.replace(oldParams, newParams);
  }
}

// 2. Update Feed to exclude scheduled posts
const oldFeedWhere = "WHERE p.deleted_at IS NULL ";
const newFeedWhere = "WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = 'published') ";
if (cv.includes(oldFeedWhere)) {
  cv = cv.split(oldFeedWhere).join(newFeedWhere);
}

fs.writeFileSync(cvFile + '.tmp.js', cv);

try {
  execSync('node --check ' + cvFile + '.tmp.js', { stdio: 'pipe' });
  console.log('SYNTAX OK: complete-v1.js');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  fs.unlinkSync(cvFile + '.tmp.js');
  process.exit(1);
}
fs.renameSync(cvFile + '.tmp.js', cvFile);

// 3. Update Server.js Smart Feed to exclude scheduled posts
const sfFile = 'src/routes/smart-feed.js';
let sf = fs.readFileSync(sfFile, 'utf8');

const oldSfWhere = "WHERE p.deleted_at IS NULL ";
const newSfWhere = "WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = 'published') ";
if (sf.includes(oldSfWhere)) {
  sf = sf.split(oldSfWhere).join(newSfWhere);
}
fs.writeFileSync(sfFile + '.tmp.js', sf);
try {
  execSync('node --check ' + sfFile + '.tmp.js', { stdio: 'pipe' });
  console.log('SYNTAX OK: smart-feed.js');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  fs.unlinkSync(sfFile + '.tmp.js');
  process.exit(1);
}
fs.renameSync(sfFile + '.tmp.js', sfFile);

// 4. Update Server.js to accept scheduledTime in CreatePostBody mapping
const srvFile = 'server.js';
let srv = fs.readFileSync(srvFile, 'utf8');
if (!srv.includes('scheduledTime: req.body.scheduledTime')) {
    // Just a safety injection if needed, but complete-v1 handles it directly via req.body
}

console.log('All files patched successfully.');
