const fs = require('fs');
let src = fs.readFileSync('server.js', 'utf8');

if (src.includes('express.static')) {
  console.log('SKIP: express.static already exists in server.js.');
  process.exit(0);
}

// Find the line where express is initialized
const anchor = 'const app = express();';
if (!src.includes(anchor)) {
  console.error('ERROR: Could not find "const app = express();" in server.js');
  process.exit(1);
}

// Add the static serving line right after it
src = src.replace(anchor, anchor + '\n\napp.use(express.static("public"));\n');
fs.writeFileSync('server.js', src);
console.log('OK: Added express.static to server.js');
