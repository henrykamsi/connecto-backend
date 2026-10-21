const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [GLOBAL-AI-BOOLEAN-FIX] */')) {
  console.log('SKIP: Global fix already applied.');
  process.exit(0);
}

const globalFix = `
/* [GLOBAL-AI-BOOLEAN-FIX] */
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (body) {
      // 1. Check if a single post is returned
      if (body.post && typeof body.post === 'object') {
        if (body.post.is_ai_content !== undefined) {
          body.post.is_ai_content = Boolean(Number(body.post.is_ai_content));
        }
      }
      // 2. Check if an array of posts is returned
      if (body.posts && Array.isArray(body.posts)) {
        body.posts.forEach(p => {
          if (p.is_ai_content !== undefined) {
            p.is_ai_content = Boolean(Number(p.is_ai_content));
          }
        });
      }
      // 3. Check if the post is returned at the root level (no "post" wrapper)
      if (body.is_ai_content !== undefined && body.id !== undefined) {
         body.is_ai_content = Boolean(Number(body.is_ai_content));
      }
    }
    return originalJson(body);
  };
  next();
});
`;

// Insert this right after express.json() middleware so it catches ALL routes
const anchor = 'app.use(express.urlencoded({';
if (!src.includes(anchor)) {
  // fallback anchor
  const fallbackAnchor = 'app.use(cors(';
  if (!src.includes(fallbackAnchor)) {
    console.log('ERROR: Could not find anchor in server.js');
    process.exit(1);
  }
  src = src.replace(fallbackAnchor, globalFix + '\n' + fallbackAnchor);
} else {
  src = src.replace(anchor, globalFix + '\n' + anchor);
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
console.log('OK: Global boolean fix applied to server.js.');
