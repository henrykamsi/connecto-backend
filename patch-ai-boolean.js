const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/* [AI-BOOLEAN-FIX] */')) {
  console.log('SKIP: Fix already applied.');
  process.exit(0);
}

// 1. Patch src/routes/complete-v1.js to return boolean
const cvFile = 'src/routes/complete-v1.js';
if (fs.existsSync(cvFile)) {
  let cv = fs.readFileSync(cvFile, 'utf8');
  if (cv.includes("INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled)")) {
    cv = cv.replace(
      "RETURNING *",
      "RETURNING id, author_id, text, audience, comments_enabled, share_enabled, created_at, deleted_at, (CASE WHEN is_ai_content = 1 THEN true ELSE false END) AS is_ai_content"
    );
    fs.writeFileSync(cvFile, cv);
    console.log('OK: Patched src/routes/complete-v1.js');
  }
}

// 2. Patch server.js control-server org post to return boolean
const anchor = "app.post(\"/api/v1/organizations/:id/post\"";
if (src.includes(anchor)) {
  src = src.replace(
    "res.status(201).json({\n      success: true,\n      post_id: postId,\n      organization: org.rows[0] || null,\n      posted_by: userId,\n      attribution: \"organization\",",
    "res.status(201).json({\n      success: true,\n      post: {\n        id: postId,\n        text: text,\n        is_ai_content: false,\n        comments_enabled: true,\n        share_enabled: true\n      },\n      organization: org.rows[0] || null,\n      posted_by: userId,\n      attribution: \"organization\","
  );
}

// 3. Patch server.js /api/v1/posts/:id endpoint just in case
src = src.replace(
  "(CASE WHEN p.is_ai_content = 1 THEN 1 ELSE 0 END) = 1 AS is_ai_content",
  "(CASE WHEN p.is_ai_content = 1 THEN true ELSE false END) AS is_ai_content"
);

// 4. Inject global safe-guard for /posts returns
const safeGuard = `
/* [AI-BOOLEAN-FIX] Force is_ai_content to boolean for Android */
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (body) {
      if (body.post && body.post.is_ai_content !== undefined) {
        body.post.is_ai_content = Boolean(body.post.is_ai_content);
      }
      if (body.posts && Array.isArray(body.posts)) {
        body.posts.forEach(p => {
          if (p.is_ai_content !== undefined) p.is_ai_content = Boolean(p.is_ai_content);
        });
      }
    }
    return originalJson(body);
  };
  next();
});
`;

if (!src.includes('[AI-BOOLEAN-FIX]')) {
  src = src.replace('app.use("/api/v1", v1);', safeGuard + '\napp.use("/api/v1", v1);');
}

fs.writeFileSync(file + '.tmp.js', src);

try {
  execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' });
  execSync('node --check ' + cvFile, { stdio: 'pipe' });
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX ERROR! Aborting.');
  console.log(e.stderr ? e.stderr.toString() : e.message);
  fs.unlinkSync(file + '.tmp.js');
  process.exit(1);
}

fs.renameSync(file + '.tmp.js', file);
console.log('OK: server.js patched securely.');
