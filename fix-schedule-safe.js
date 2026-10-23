const fs = require('fs');
const { execSync } = require('child_process');

const cvFile = 'src/routes/complete-v1.js';
let cv = fs.readFileSync(cvFile, 'utf8');

// 1. Safe Schema injection
if (!cv.includes('[SCHEDULE-FIX]')) {
  const schemaCheck = `
/* [SCHEDULE-FIX] */
(async () => {
  try {
    const { run } = require('../db');
    try { await run("ALTER TABLE posts ADD COLUMN scheduled_at TEXT"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published'"); } catch(e){}
    console.log("[SCHEDULE] DB columns ready.");
  } catch(e) { console.error("[SCHEDULE]", e.message); }
})();
`;
  cv = schemaCheck + '\n' + cv;
}

// 2. Safely update the INSERT query (using exact line match from earlier)
const oldInsert = `      \`INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, author_id, text, audience, comments_enabled, share_enabled, created_at, deleted_at, (CASE WHEN is_ai_content = 1 THEN true ELSE false END) AS is_ai_content\`,`;

const newInsert = `      \`INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content, scheduled_at, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, author_id, text, audience, comments_enabled, share_enabled, created_at, deleted_at, (CASE WHEN is_ai_content = 1 THEN true ELSE false END) AS is_ai_content\`,`;

if (cv.includes(oldInsert)) {
  cv = cv.replace(oldInsert, newInsert);
  
  const oldParams = `        req.body.privacy || 'public',
        req.body.boost_boost ? 1 : 0,
        req.body.is_ai_content ? 1 : 0
      ]`;
  const newParams = `        req.body.privacy || 'public',
        req.body.boost_boost ? 1 : 0,
        req.body.is_ai_content ? 1 : 0,
        req.body.scheduledTime || null,
        req.body.scheduledTime ? 'scheduled' : 'published'
      ]`;
      
  if (cv.includes(oldParams)) {
    cv = cv.replace(oldParams, newParams);
  }
}

// 3. Safely update the FEED query to hide scheduled posts
const oldFeedWhere = "WHERE p.deleted_at IS NULL \n         AND u.account_status='active'";
const newFeedWhere = "WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = 'published') \n         AND u.account_status='active'";
if (cv.includes(oldFeedWhere)) {
  cv = cv.replace(oldFeedWhere, newFeedWhere);
} else {
    // Fallback for generic where clause
    cv = cv.replace(/WHERE p\.deleted_at IS NULL/g, "WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = 'published')");
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

// 4. Safely update smart-feed.js
const sfFile = 'src/routes/smart-feed.js';
let sf = fs.readFileSync(sfFile, 'utf8');
sf = sf.replace(/WHERE p\.deleted_at IS NULL/g, "WHERE p.deleted_at IS NULL AND (p.status IS NULL OR p.status = 'published')");

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

console.log('All files patched successfully.');
