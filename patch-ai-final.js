const fs = require('fs');
const { execSync } = require('child_process');

const file = 'src/routes/complete-v1.js';
if (!fs.existsSync(file)) {
  console.log('ERROR: complete-v1.js not found');
  process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [FINAL-AI-FIX] */')) {
  console.log('SKIP: Final AI fix already applied.');
  process.exit(0);
}

// Target the exact POST /posts route in complete-v1.js
const oldResponse = `
    res.status(201).json({
      success:true,
      post
    });
`;

const newResponse = `
    /* [FINAL-AI-FIX] */
    if (post) {
      post.is_ai_content = post.is_ai_content === 1 || post.is_ai_content === '1' || post.is_ai_content === true;
      post.comments_enabled = post.comments_enabled === 1 || post.comments_enabled === '1' || post.comments_enabled === true;
      post.share_enabled = post.share_enabled === 1 || post.share_enabled === '1' || post.share_enabled === true;
    }

    res.status(201).json({
      success:true,
      post
    });
`;

if (!src.includes(oldResponse)) {
  console.log('ERROR: Could not find the POST /posts response block in complete-v1.js.');
  // Try a looser match
  const looseOld = `res.status(201).json({\n      success:true,\n      post\n    });`;
  if (src.includes(looseOld)) {
      src = src.replace(looseOld, newResponse);
  } else {
      console.log('ERROR: Both exact and loose matches failed. Check complete-v1.js.');
      process.exit(1);
  }
} else {
  src = src.replace(oldResponse, newResponse);
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
console.log('OK: complete-v1.js patched securely.');
