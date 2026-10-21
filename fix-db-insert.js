const fs = require('fs');
const { execSync } = require('child_process');

const file = 'src/routes/complete-v1.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('is_ai_content, boost_boost, privacy)')) {
  console.log('SKIP: DB Insert already fixed.');
  process.exit(0);
}

// Find the POST /posts insert query and completely replace the arguments
const oldInsertRegex = /INSERT INTO posts\(id,author_id,text,audience,comments_enabled,share_enabled\)\s*VALUES\(\$1,\$2,\$3,\$4,\$5,\$6\)\s*RETURNING \*/;
const newInsert = `INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled,privacy,boost_boost,is_ai_content)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`;

if (!oldInsertRegex.test(src)) {
  console.log('ERROR: Could not find INSERT query regex.');
  process.exit(1);
}
src = src.replace(oldInsertRegex, newInsert);

// Now replace the arguments array that goes with it
const oldArgsRegex = /\[\s*uuidv4\(\),\s*req\.user\.id,\s*req\.body\.body \|\| null,\s*req\.body\.visibility \|\| 'public',\s*req\.body\.commentsEnabled !== false,\s*req\.body\.shareEnabled !== false\s*\]/;
const newArgs = `[
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

if (!oldArgsRegex.test(src)) {
  console.log('WARNING: Could not find exact args regex. Using fallback text replacement.');
  src = src.replace(
    "req.body.commentsEnabled !== false,\n        req.body.shareEnabled !== false\n      ]",
    "req.body.commentsEnabled !== false,\n        req.body.shareEnabled !== false,\n        req.body.privacy || 'public',\n        req.body.boost_boost ? 1 : 0,\n        req.body.is_ai_content ? 1 : 0\n      ]"
  );
} else {
  src = src.replace(oldArgsRegex, newArgs);
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
console.log('OK: complete-v1.js successfully patched at the database level.');
