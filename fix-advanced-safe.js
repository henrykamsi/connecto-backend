const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [ADVANCED-SETTINGS-SAFE] */')) {
  console.log('SKIP: Already applied.');
  process.exit(0);
}

const safePatch = `
/* [ADVANCED-SETTINGS-SAFE] Intercept POST /posts to save AI, privacy, and boost */
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/v1/posts') {
    const originalJson = res.json.bind(res);
    res.json = async function(body) {
      if (body && body.success && body.post && body.post.id) {
        try {
          const { run } = require("./src/db");
          await run(
            "UPDATE posts SET is_ai_content=$1, privacy=$2, boost_boost=$3 WHERE id=$4",
            [
              req.body.is_ai_content ? 1 : 0,
              req.body.privacy || 'public',
              req.body.boost_boost ? 1 : 0,
              body.post.id
            ]
          );
          body.post.is_ai_content = Boolean(req.body.is_ai_content);
        } catch (e) {
          console.error("[ADVANCED-SETTINGS-SAFE]", e.message);
        }
      }
      return originalJson(body);
    };
  }
  next();
});

/* [ADVANCED-SETTINGS-SAFE] Ensure columns exist */
(async () => {
  try {
    const { run } = require("./src/db");
    try { await run("ALTER TABLE posts ADD COLUMN privacy TEXT DEFAULT 'public'"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN boost_boost INTEGER DEFAULT 0"); } catch(e){}
    try { await run("ALTER TABLE posts ADD COLUMN is_ai_content INTEGER DEFAULT 0"); } catch(e){}
    console.log("[ADVANCED-SETTINGS] DB columns ready.");
  } catch(e) { console.error("[ADVANCED-SETTINGS]", e.message); }
})();
`;

// Insert right after cors so it catches all requests safely
const anchor = 'app.use(express.json(';
if (!src.includes(anchor)) {
  console.log('ERROR: Could not find express.json in server.js');
  process.exit(1);
}

src = src.replace(anchor, safePatch + '\n' + anchor);

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
console.log('OK: server.js patched securely.');
