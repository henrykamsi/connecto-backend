const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');

const {
  getSignedUrl
} = require('@aws-sdk/s3-request-presigner');

const env = require('../config/env');
const crypto = require('crypto');

async function getB2Creds() {
  try {
    const { query } = require('../db');
    const r = await query(
      "SELECT * FROM provider_credentials WHERE category='storage' AND provider='b2' AND is_active=1 ORDER BY is_primary DESC, priority ASC LIMIT 1"
    );
    if (r.rows.length) {
      const row = r.rows[0];
      const KEY = process.env.CONTROL_ENCRYPTION_KEY;
      if (KEY) {
        const raw = Buffer.from(row.credentials_enc, "base64");
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const data = raw.subarray(28);
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          Buffer.from(KEY, "hex"),
          iv
        );
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
        const cred = JSON.parse(decrypted.toString("utf8"));
        return {
          endpoint: cred.endpoint,
          region: cred.region,
          bucket: cred.bucket,
          keyId: cred.keyId,
          applicationKey: cred.applicationKey
        };
      }
    }
  } catch (e) {
    console.error("[B2] panel read failed:", e.message);
  }
  return {
    endpoint: env.b2.endpoint,
    region: env.b2.region,
    bucket: env.b2.bucket,
    keyId: env.b2.keyId,
    applicationKey: env.b2.applicationKey
  };
}

function makeClient(creds) {
  return new S3Client({
    endpoint: creds.endpoint,
    region: creds.region,
    credentials: {
      accessKeyId: creds.keyId,
      secretAccessKey: creds.applicationKey
    },
    forcePathStyle: true
  });
}

async function configured() {
  const c = await getB2Creds();
  return !!(c.endpoint && c.region && c.bucket && c.keyId && c.applicationKey);
}

async function upload(key, body, contentType) {
  const creds = await getB2Creds();
  if (!creds.endpoint || !creds.keyId) throw new Error('B2 is not configured');
  const s3 = makeClient(creds);
  await s3.send(new PutObjectCommand({
    Bucket: creds.bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
  return key;
}

async function signedDownload(key, seconds = 900) {
  const creds = await getB2Creds();
  if (!creds.endpoint || !creds.keyId) throw new Error('B2 is not configured');
  const s3 = makeClient(creds);
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: creds.bucket,
      Key: key
    }),
    { expiresIn: seconds }
  );
}

async function remove(key) {
  const creds = await getB2Creds();
  if (!creds.endpoint || !creds.keyId) throw new Error('B2 is not configured');
  const s3 = makeClient(creds);
  await s3.send(new DeleteObjectCommand({
    Bucket: creds.bucket,
    Key: key
  }));
}

module.exports = { configured, upload, signedDownload, remove, getB2Creds };
