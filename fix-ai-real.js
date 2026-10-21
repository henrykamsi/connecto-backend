const fs = require('fs');
const { execSync } = require('child_process');

let src = fs.readFileSync('server.js', 'utf8');
const before = src;

// The [POST-DETAIL] handler is the one returning $.post
// We need to make sure it returns a REAL boolean for is_ai_content
const target = "p.is_ai_content, u.first_name";
const replacement = "(CASE WHEN p.is_ai_content = 1 THEN 1 ELSE 0 END) = 1 AS is_ai_content, u.first_name";

if (src.includes(target)) {
  src = src.replace(new RegExp(target, 'g'), replacement);
  fs.writeFileSync('server.js', src);
  console.log("OK: POST-DETAIL is_ai_content is now a real boolean");
} else {
  console.log("TARGET NOT FOUND. Searching for is_ai_content...");
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('is_ai_content')) {
      console.log((i+1) + ": " + line.trim());
    }
  });
  process.exit(1);
}

try {
  execSync('node --check server.js', { stdio: 'pipe' });
  execSync('git add server.js && git commit -m "fix: force is_ai_content to be a real boolean" && git push origin main', { stdio: 'inherit' });
  console.log("PUSHED. Wait 2 mins for Render.");
} catch (e) {
  console.log("Syntax error or git failed.");
  if (e.stderr) console.log(e.stderr.toString());
}
