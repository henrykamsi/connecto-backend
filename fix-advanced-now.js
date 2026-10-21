const fs = require('fs');
const { execSync } = require('child_process');

const file = 'src/routes/complete-v1.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [ADVANCED-SETTINGS-FINAL] */')) {
  console.log('SKIP: Already fixed.');
  process.exit(0);
}

// Find the POST /posts route safely
const routeStart = src.indexOf("router.post('/posts'");
if (routeStart === -1) {
  console.log("ERROR: Could not find POST /posts route.");
  process.exit(1);
}

// Find the INSERT query inside that route
const insertIdx = src.indexOf("INSERT INTO posts(", routeStart);
if (insertIdx === -1) {
  console.log("ERROR: Could not find INSERT INTO posts.");
  process.exit(1);
}

const insertEnd = src.indexOf(");", insertIdx);
if (insertEnd === -1) {
  console.log("ERROR: Could not find end of INSERT query.");
  process.exit(1);
}

// The original INSERT block
const originalBlock = src.substring(insertIdx, insertEnd + 2);

// The new INSERT block with AI, privacy, and boost
const newBlock = `
    /* [ADVANCED-SETTINGS-FINAL] */
    const result = await query(
      \`INSERT INTO posts(id, author_id, text, audience, comments_enabled, share_enabled, privacy, boost_boost, is_ai_content)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *\`,
      [
        uuidv4(),
        req.user.id,
        req.body.body || null,
        req.body.visibility || 'public',
        req.body.commentsEnabled !== false,
        req.body.shareEnabled !== false,
        req.body.privacy || 'public',
        req.body.boost_boost ? 1 : 0,
        req.body.is_ai_content ? 1 : 0
      ]
    );`;

// Replace the old block
src = src.substring(0, insertIdx) + newBlock + src.substring(insertEnd + 2);

// Ensure columns exist on startup
const schemaFix = `
(async () => {
  try {
    const { run } = require('../db');
    try { await run("ALTER TABLE posts ADD COLUMN privacy TEXT DEFAULT 'public'"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN boost_boost INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN is_ai_content INTEGER DEFAULT 0"); } catch(e){}
    console.log("[ADVANCED-SETTINGS] DB columns verified.");
  } catch(e) { console.error("[ADVANCED-SETTINGS]", e.message); }
})();
`;

if (!src.includes("[ADVANCED-SETTINGS] DB columns verified")) {
  src = schemaFix + "\n" + src;
}

fs.writeFileSync(file + '.tmp.js', src);

try {
  execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' });
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  fs.unlinkSync(file + '.tmp.js');
  process.exit(1);
}

fs.renameSync(file + '.tmp.js', file);
console.log('OK: complete-v1.js successfully patched.');
