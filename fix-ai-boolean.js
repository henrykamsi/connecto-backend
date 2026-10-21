const fs = require('fs');
const { execSync } = require('child_process');

const files = ['server.js', 'src/routes/complete-v1.js'];
let changed = false;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  // Fix in /posts/:id and /feed/smart queries
  src = src.replace(/p\.is_ai_content, u\.first_name/g, "CAST(p.is_ai_content AS BOOLEAN) AS is_ai_content, u.first_name");
  
  // Fix in SELECT statements that just have p.is_ai_content
  src = src.replace(/p\.is_ai_content,/g, "CAST(p.is_ai_content AS BOOLEAN) AS is_ai_content,");
  
  // Fix in the [POST-DETAIL] handler where it's selected explicitly
  src = src.replace(/p\.is_ai_content\s+/g, "CAST(p.is_ai_content AS BOOLEAN) AS is_ai_content ");

  if (src !== before) {
    fs.writeFileSync(file, src);
    console.log("Fixed " + file);
    changed = true;
  }
}

if (changed) {
  try {
    execSync('git add -A && git commit -m "fix: return is_ai_content as boolean to match Android DTO" && git push origin main', { stdio: 'inherit' });
    console.log("PUSHED. Wait 2 mins for Render.");
  } catch (e) {
    console.log("Git push failed.");
  }
} else {
  console.log("No changes needed or files not found.");
}
