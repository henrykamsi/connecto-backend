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

let client = null;

function configured() {
  return !!(
    env.b2.endpoint &&
    env.b2.region &&
    env.b2.bucket &&
    env.b2.keyId &&
    env.b2.applicationKey
  );
}

function getClient() {
  if (!configured()) return null;

  if (!client) {
    client = new S3Client({
      endpoint:env.b2.endpoint,
      region:env.b2.region,
      credentials:{
        accessKeyId:env.b2.keyId,
        secretAccessKey:env.b2.applicationKey
      },
      forcePathStyle:true
    });
  }

  return client;
}

async function upload(key, body, contentType) {
  const s3 = getClient();
  if (!s3) throw new Error('B2 is not configured');

  await s3.send(new PutObjectCommand({
    Bucket:env.b2.bucket,
    Key:key,
    Body:body,
    ContentType:contentType
  }));

  return key;
}

async function signedDownload(key, seconds=900) {
  const s3 = getClient();
  if (!s3) throw new Error('B2 is not configured');

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket:env.b2.bucket,
      Key:key
    }),
    {expiresIn:seconds}
  );
}

async function remove(key) {
  const s3 = getClient();
  if (!s3) throw new Error('B2 is not configured');

  await s3.send(new DeleteObjectCommand({
    Bucket:env.b2.bucket,
    Key:key
  }));
}

module.exports = { configured, upload, signedDownload, remove };
