const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

if (s.includes('SMART-FEED-MOUNT')) {
  console.log('already mounted — skipping');
  process.exit(0);
}

const anchor = 'app.use("/api/v1", v1);';
if (!s.includes(anchor)) {
  console.error('ERROR: anchor not found in server.js');
  process.exit(1);
}

const insert =
  '/* [SMART-FEED-MOUNT] Additive — does not affect existing routes */\n' +
  'const smartFeedRouter = require("./src/routes/smart-feed");\n' +
  'app.use("/api/v1", smartFeedRouter);\n\n';

s = s.replace(anchor, insert + anchor);
fs.writeFileSync('server.js', s);
console.log('mounted');
