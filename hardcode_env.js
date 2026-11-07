const fs = require('fs');
let src = fs.readFileSync('server.js', 'utf8');

if (src.includes('HARDCODED ENV VARS')) {
  console.log('Already hardcoded. Skipping.');
  process.exit(0);
}

const envBlock = `
/* HARDCODED ENV VARS (Bypassing Render Dashboard) */
process.env.AGORA_APP_ID = "078f33ef0c8d41bcbfea839223d2b6b3";
process.env.AGORA_APP_CERTIFICATE = "58f5176bab644d89922ffd98b3a0f52b";
process.env.AGORA_WEBHOOK_SECRET = "2KV47KHT-n";
process.env.MAX_CALL_MINUTES = "10";
process.env.CALL_WARNING_MINUTES = "1";
`;

src = src.replace('require("dotenv").config();', 'require("dotenv").config();\n' + envBlock);

fs.writeFileSync('server.js', src);
console.log('Successfully hardcoded Agora credentials into server.js');
