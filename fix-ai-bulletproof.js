const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [AI-BULLETPROOF] */')) {
  console.log('SKIP: Already applied.');
  process.exit(0);
}

const patch = `
/* [AI-BULLETPROOF] */
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/v1/posts') {
    const originalJson = res.json.bind(res);
    res.json = async function(body) {
      if (body && body.success && body.post && body.post.id) {
        console.log("[AI-BULLETPROOF] Post created:", body.post.id);
        console.log("[AI-BULLETPROOF] req.body.is_ai_content:", req.body.is_ai_content);
        try {
          const { run } = require("./src/db");
          const val = (req.body.is_ai_content === true || req.body.is_ai_content === 1 || req.body.is_ai_content === '1') ? 1 : 0;
          await run("UPDATE posts SET is_ai_content=$1 WHERE id=$2", [val, body.post.id]);
          console.log("[AI-BULLETPROOF] DB updated is_ai_content to:", val);
          body.post.is_ai_content = val === 1; // Force response to be true/false
        } catch (e) {
          console.error("[AI-BULLETPROOF] DB ERROR:", e.message);
        }
      }
      return originalJson(body);
    };
  }
  next();
});
`;

src = src.replace('app.use(express.json(', patch + '\napp.use(express.json(');

// Also patch the GET /feed/smart to ensure it returns the AI content
const smartFeedFile = 'src/routes/smart-feed.js';
if (fs.existsSync(smartFeedFile)) {
  let sf = fs.readFileSync(smartFeedFile, 'utf8');
  if (!sf.includes('p.is_ai_content')) {
    sf = sf.replace('p.category, u.first_name', 'p.category, p.is_ai_content, u.first_name');
    fs.writeFileSync(smartFeedFile, sf);
    console.log('OK: Patched smart-feed.js to include is_ai_content');
  }
}

fs.writeFileSync(file + '.tmp.js', src);

try {
  execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' });
  execSync('node --check ' + smartFeedFile, { stdio: 'pipe' });
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  fs.unlinkSync(file + '.tmp.js');
  process.exit(1);
}

fs.renameSync(file + '.tmp.js', file);
console.log('OK: server.js patched securely.');
