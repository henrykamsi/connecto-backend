const fs = require('fs');
const { execSync } = require('child_process');

// 1. Patch complete-v1.js POST /posts to accept advanced settings
const file = 'src/routes/complete-v1.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [ADVANCED-SETTINGS-FIX] */')) {
  console.log('SKIP: Advanced settings already patched.');
  process.exit(0);
}

const oldInsert = `INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        uuidv4(),
        req.user.id,
        req.body.body || null,
        req.body.visibility || 'public',
        req.body.commentsEnabled !== false,
        req.body.shareEnabled !== false
      ]`;

const newInsert = `/* [ADVANCED-SETTINGS-FIX] */
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

if (!src.includes(oldInsert)) {
  console.log('ERROR: Could not find the INSERT block in complete-v1.js');
  process.exit(1);
}

src = src.replace(oldInsert, newInsert);

// 2. Ensure the columns exist in Turso DB
const schemaFix = `
(async () => {
  try {
    const { run } = require('../db');
    try { await run("ALTER TABLE posts ADD COLUMN privacy TEXT DEFAULT 'public'"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN boost_boost INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN is_ai_content INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN is_approved INTEGER DEFAULT 1"); } catch(e){}
    console.log("[ADVANCED-SETTINGS] DB columns verified.");
  } catch(e) { console.error("[ADVANCED-SETTINGS]", e.message); }
})();
`;
src = schemaFix + "\n" + src;

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
console.log('OK: complete-v1.js patched for advanced settings.');
