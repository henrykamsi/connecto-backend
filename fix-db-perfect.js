const fs = require('fs');
const { execSync } = require('child_process');

const file = 'src/routes/complete-v1.js';
let src = fs.readFileSync(file, 'utf8');

const oldBlock = `      \`INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id, author_id, text, audience, comments_enabled, share_enabled, created_at, deleted_at, (CASE WHEN is_ai_content = 1 THEN true ELSE false END) AS is_ai_content\`,
      [
        uuidv4(),
        req.user.id,
        req.body.body || null,
        req.body.visibility || 'public',
        req.body.commentsEnabled !== false,
        req.body.shareEnabled !== false
      ]`;

const newBlock = `      \`INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, author_id, text, audience, comments_enabled, share_enabled, created_at, deleted_at, (CASE WHEN is_ai_content = 1 THEN true ELSE false END) AS is_ai_content\`,
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
      ]`;

if (!src.includes(oldBlock)) {
  console.log('ERROR: Could not find the exact block. Please run the grep command again.');
  process.exit(1);
}

src = src.replace(oldBlock, newBlock);

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
console.log('OK: complete-v1.js patched perfectly.');
