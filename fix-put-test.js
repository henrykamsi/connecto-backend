const fs = require('fs');
const { execSync } = require('child_process');

const file = 'server.js';
const src = fs.readFileSync(file, 'utf8');

if (src.includes('[DIAG-PUT]')) {
  console.log('Already added.');
  process.exit(0);
}

const anchor = 'app.use((err, req, res, next) => {';
if (!src.includes(anchor)) {
  console.log('Error handler anchor not found.');
  process.exit(1);
}

const block =
"/* [DIAG-PUT] */\n" +
"app.get('/api/v1/diag/put', async (req, res) => {\n" +
"  const https = require('https');\n" +
"  const http = require('http');\n" +
"  try {\n" +
"    const b2 = require('./src/providers/b2');\n" +
"    const key = 'users/diag/put-test-' + Date.now() + '.txt';\n" +
"    const body = 'hello from diag ' + new Date().toISOString();\n" +
"    const putUrl = await b2.upload\n" +
"      ? null\n" +
"      : null;\n" +
"    // Use the same signing path as [PATCH-C]: signB2Put\n" +
"    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');\n" +
"    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');\n" +
"    const creds = await b2.getB2Creds();\n" +
"    const s3 = new S3Client({\n" +
"      endpoint: creds.endpoint,\n" +
"      region: creds.region,\n" +
"      credentials: { accessKeyId: creds.keyId, secretAccessKey: creds.applicationKey },\n" +
"      forcePathStyle: true\n" +
"    });\n" +
"    const cmd = new PutObjectCommand({ Bucket: creds.bucket, Key: key, ContentType: 'text/plain' });\n" +
"    const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });\n" +
"    // Actually PUT the small body to B2 using the signed URL\n" +
"    const result = await new Promise((resolve) => {\n" +
"      const urlObj = new URL(signedUrl);\n" +
"      const req2 = https.request({\n" +
"        method: 'PUT',\n" +
"        hostname: urlObj.hostname,\n" +
"        path: urlObj.pathname + urlObj.search,\n" +
"        headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }\n" +
"      }, (r) => {\n" +
"        let data = '';\n" +
"        r.on('data', (c) => data += c);\n" +
"        r.on('end', () => resolve({ status: r.statusCode, body: data.slice(0, 500) }));\n" +
"      });\n" +
"      req2.on('error', (e) => resolve({ status: 'network-error', body: e.message }));\n" +
"      req2.write(body);\n" +
"      req2.end();\n" +
"    });\n" +
"    // Try to read back the file\n" +
"    let readback = null;\n" +
"    try {\n" +
"      const readUrl = await b2.signedDownload(key, 60);\n" +
"      const readResult = await new Promise((resolve) => {\n" +
"        const urlObj = new URL(readUrl);\n" +
"        https.get({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search }, (r) => {\n" +
"          let data = '';\n" +
"          r.on('data', (c) => data += c);\n" +
"          r.on('end', () => resolve({ status: r.statusCode, body: data.slice(0, 200) }));\n" +
"        }).on('error', (e) => resolve({ status: 'err', body: e.message }));\n" +
"      });\n" +
"      readback = readResult;\n" +
"    } catch (e) {\n" +
"      readback = { error: e.message };\n" +
"    }\n" +
"    res.json({\n" +
"      success: true,\n" +
"      put: result,\n" +
"      readback: readback,\n" +
"      key: key\n" +
"    });\n" +
"  } catch (e) {\n" +
"    res.status(500).json({ success: false, error: e.message, stack: e.stack });\n" +
"  }\n" +
"});\n" +
"/* [/DIAG-PUT] */\n\n";

fs.writeFileSync(file + '.tmp.js', src.replace(anchor, block + anchor));
try { execSync('node --check ' + file + '.tmp.js', { stdio: 'pipe' }); }
catch (e) {
  console.log('SYNTAX FAIL');
  console.log((e.stderr ? e.stderr.toString() : e.message).slice(0, 300));
  fs.unlinkSync(file + '.tmp.js');
  process.exit(1);
}
fs.renameSync(file + '.tmp.js', file);
console.log('OK server.js updated');

execSync('git add -A && git commit -m "diag: add PUT test to diagnose B2 upload" && git push origin main', { stdio: 'inherit' });
console.log('PUSHED.');
