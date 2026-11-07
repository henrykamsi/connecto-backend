const crypto = require('crypto');
const zlib = require('zlib');

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function genUserSig(sdkAppId, secretKey, userId, expire = 86400) {
  const currTime = Math.floor(Date.now() / 1000);
  const rawContent = JSON.stringify({
    "TLS.ver": "2.0",
    "TLS.identifier": userId,
    "TLS.sdkappid": sdkAppId,
    "TLS.expire": expire,
    "TLS.time": currTime,
  });

  const compressedContent = zlib.deflateSync(Buffer.from(rawContent, 'utf8')).toString('base64');
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(compressedContent);
  const signature = hmac.digest('base64');

  const finalContent = JSON.stringify({
    "TLS.ver": "2.0",
    "TLS.identifier": userId,
    "TLS.sdkappid": sdkAppId,
    "TLS.expire": expire,
    "TLS.time": currTime,
    "TLS.sig": signature,
    "TLS.content": compressedContent
  });

  return base64UrlEncode(finalContent);
}

module.exports = { genUserSig };
