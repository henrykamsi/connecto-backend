const fs = require('fs');
const { execSync } = require('child_process');

let src = fs.readFileSync('server.js', 'utf8');

const broken = "CAST(CAST(p.is_ai_content AS BOOLEAN) AS is_ai_content AS BOOLEAN) AS is_ai_content";
const fixed  = "(CASE WHEN p.is_ai_content = 1 THEN 1 ELSE 0 END) = 1 AS is_ai_content";

const count = src.split(broken).length - 1;

if (count === 0) {
  console.log("Broken SQL not found. Checking for other issues...");
  process.exit(1);
}

src = src.split(broken).join(fixed);
fs.writeFileSync('server.js', src);
console.log(`Fixed ${count} broken SQL block(s).`);

try {
  execSync('node --check server.js', { stdio: 'pipe' });
  console.log('Syntax OK.');
  execSync('git add server.js && git commit -m "fix: correct broken SQL syntax for is_ai_content boolean" && git push origin main', { stdio: 'inherit' });
  console.log('PUSHED. Wait 2 mins for Render.');
} catch (e) {
  console.log('Failed.');
  if (e.stderr) console.log(e.stderr.toString());
}
