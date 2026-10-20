const https = require('https');

function hit(path, method, body) {
  return new Promise((resolve) => {
    const url = new URL('https://connecto-backend-luxa.onrender.com' + path);
    const opts = {
      method: method || 'GET',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        console.log('---');
        console.log(method + ' ' + path);
        console.log('HTTP ' + res.statusCode);
        console.log('Body: ' + data.slice(0, 600));
        console.log('');
        resolve();
      });
    });
    req.on('error', (e) => {
      console.log('---');
      console.log(method + ' ' + path);
      console.log('NETWORK ERROR: ' + e.message);
      console.log('');
      resolve();
    });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  await hit('/api/v1/health');
  await hit('/api/v1/search?q=john');
  await hit('/api/v1/media/upload-url', 'POST', JSON.stringify({content_type:'image/jpeg', file_size:1000, media_type:'image'}));
  await hit('/api/v1/posts/abc/comments', 'POST', JSON.stringify({body:'hi'}));
  process.exit(0);
})();
