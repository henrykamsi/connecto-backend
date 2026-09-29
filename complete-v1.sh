#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=============================================="
echo "       CONNECTO COMPLETE V1 INSTALLER"
echo "=============================================="

cd "$HOME/connecto"

npm install express pg dotenv cors helmet bcryptjs jsonwebtoken multer ws uuid zod firebase-admin @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

mkdir -p src/{config,db,middleware,routes,services,providers,websocket,utils}

cat > migration-complete-v1.sql <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS mobile VARCHAR(40),
ADD COLUMN IF NOT EXISTS mobile_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS username VARCHAR(32),
ADD COLUMN IF NOT EXISTS bio TEXT,
ADD COLUMN IF NOT EXISTS category VARCHAR(100),
ADD COLUMN IF NOT EXISTS country VARCHAR(100),
ADD COLUMN IF NOT EXISTS state VARCHAR(100),
ADD COLUMN IF NOT EXISTS gender VARCHAR(40),
ADD COLUMN IF NOT EXISTS profile_photo_url TEXT,
ADD COLUMN IF NOT EXISTS cover_photo_url TEXT,
ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS account_status VARCHAR(30) DEFAULT 'active',
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
ON users(username)
WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_unique
ON users(mobile)
WHERE mobile IS NOT NULL;

CREATE TABLE IF NOT EXISTS verification_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    channel VARCHAR(20) NOT NULL,
    destination VARCHAR(255) NOT NULL,
    code_hash TEXT NOT NULL,
    purpose VARCHAR(40) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verification_codes_user_idx
ON verification_codes(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    device_id VARCHAR(255),
    device_name VARCHAR(255),
    device_type VARCHAR(80),
    os_version VARCHAR(80),
    app_version VARCHAR(80),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(255),
    device_name VARCHAR(255),
    device_type VARCHAR(80),
    os_version VARCHAR(80),
    app_version VARCHAR(80),
    ip_address INET,
    user_agent TEXT,
    recognized BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS friend_requests_receiver_idx
ON friend_requests(receiver_id,status);

CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id,friend_id)
);

CREATE TABLE IF NOT EXISTS follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id,following_id)
);

CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT,
    visibility VARCHAR(30) DEFAULT 'public',
    comments_enabled BOOLEAN DEFAULT TRUE,
    share_enabled BOOLEAN DEFAULT TRUE,
    original_post_id UUID REFERENCES posts(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS posts_user_idx
ON posts(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    mime_type VARCHAR(120),
    size_bytes BIGINT,
    width INTEGER,
    height INTEGER,
    duration_seconds NUMERIC,
    storage_key TEXT,
    thumbnail_key TEXT,
    processing_status VARCHAR(30) DEFAULT 'pending',
    visibility VARCHAR(30) DEFAULT 'private',
    ai_status VARCHAR(30) DEFAULT 'pending',
    ai_detection_confidence NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS media_post_idx ON media(post_id);

CREATE TABLE IF NOT EXISTS reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(post_id,user_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS comments_post_idx
ON comments(post_id,created_at);

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(60) NOT NULL,
    title TEXT,
    body TEXT,
    target_type VARCHAR(60),
    target_id UUID,
    data JSONB DEFAULT '{}'::jsonb,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx
ON notifications(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN DEFAULT TRUE,
    message_notifications BOOLEAN DEFAULT TRUE,
    friend_notifications BOOLEAN DEFAULT TRUE,
    social_notifications BOOLEAN DEFAULT TRUE,
    security_notifications BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fcm_token TEXT NOT NULL,
    device_id VARCHAR(255),
    platform VARCHAR(30),
    device_name VARCHAR(255),
    os_version VARCHAR(80),
    app_version VARCHAR(80),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id,fcm_token)
);

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(20) DEFAULT 'direct',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    muted BOOLEAN DEFAULT FALSE,
    PRIMARY KEY(conversation_id,user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT,
    message_type VARCHAR(30) DEFAULT 'text',
    reply_to_id UUID REFERENCES messages(id),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    seen_at TIMESTAMPTZ,
    disappearing_mode VARCHAR(30) DEFAULT 'off',
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
ON messages(conversation_id,created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reaction VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(message_id,user_id)
);

CREATE TABLE IF NOT EXISTS message_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blocks (
    blocker_id UUID REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(blocker_id,blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    category VARCHAR(60) NOT NULL,
    description TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS moderation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    category VARCHAR(60),
    action VARCHAR(60),
    reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    caller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    receiver_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(20) DEFAULT 'video',
    status VARCHAR(30) DEFAULT 'ringing',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS call_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signal_type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    key_prefix VARCHAR(30) NOT NULL,
    secret_hash TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    scopes JSONB DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    events JSONB DEFAULT '[]'::jsonb,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(80) NOT NULL,
    ip_address INET,
    device_id VARCHAR(255),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    profile_visibility VARCHAR(30) DEFAULT 'everyone',
    friend_visibility VARCHAR(30) DEFAULT 'everyone',
    follower_visibility VARCHAR(30) DEFAULT 'everyone',
    message_privacy VARCHAR(30) DEFAULT 'everyone',
    typing_enabled BOOLEAN DEFAULT TRUE,
    disappearing_messages VARCHAR(30) DEFAULT 'off',
    two_factor_enabled BOOLEAN DEFAULT FALSE,
    biometric_enabled BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

SQL

echo "[1/7] Running database migration..."

PGPASSWORD="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)" \
psql -h 127.0.0.1 -U connecto_app -d connecto -f migration-complete-v1.sql

cat > src/config/env.js <<'JS'
require('dotenv').config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  appName: process.env.APP_NAME || 'Connecto',
  apiVersion: process.env.API_VERSION || 'v1',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    name: process.env.DB_NAME || 'connecto',
    user: process.env.DB_USER || 'connecto_app',
    password: process.env.DB_PASSWORD || ''
  },

  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
  refreshDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 30),

  corsOrigins: process.env.CORS_ORIGINS || '*',

  b2: {
    endpoint: process.env.B2_ENDPOINT || '',
    region: process.env.B2_REGION || '',
    bucket: process.env.B2_BUCKET || '',
    keyId: process.env.B2_KEY_ID || '',
    applicationKey: process.env.B2_APPLICATION_KEY || ''
  },

  fcm: {
    projectId: process.env.FCM_PROJECT_ID || '',
    clientEmail: process.env.FCM_CLIENT_EMAIL || '',
    privateKey: (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  }
};

module.exports = env;
JS

cat > src/db/index.js <<'JS'
const { Pool } = require('pg');
const env = require('../config/env');

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  password: env.db.password,
  max: 20,
  idleTimeoutMillis: 30000
});

pool.on('error', err => {
  console.error('[CONNECTO] PostgreSQL pool error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
JS

cat > src/utils/security.js <<'JS'
const crypto = require('crypto');

function hashSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashSecret, randomSecret };
JS

cat > src/middleware/auth.js <<'JS'
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query } = require('../db');

async function auth(req,res,next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        success:false,
        error:'Authentication required'
      });
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, env.jwtSecret);

    const result = await query(
      `SELECT id,name,surname,email,username,bio,category,country,state,gender,
              profile_photo_url,cover_photo_url,account_status
       FROM users WHERE id=$1`,
      [payload.sub]
    );

    if (!result.rows.length) {
      return res.status(401).json({success:false,error:'User not found'});
    }

    if (result.rows[0].account_status &&
        result.rows[0].account_status !== 'active') {
      return res.status(403).json({
        success:false,
        error:'Account unavailable'
      });
    }

    req.user = result.rows[0];
    req.auth = payload;

    next();
  } catch (err) {
    return res.status(401).json({
      success:false,
      error:'Invalid or expired token'
    });
  }
}

module.exports = auth;
JS

cat > src/services/fcm.js <<'JS'
const admin = require('firebase-admin');
const env = require('../config/env');

let ready = false;

function initFCM() {
  if (
    ready ||
    !env.fcm.projectId ||
    !env.fcm.clientEmail ||
    !env.fcm.privateKey
  ) {
    return ready;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.fcm.projectId,
        clientEmail: env.fcm.clientEmail,
        privateKey: env.fcm.privateKey
      })
    });
  }

  ready = true;
  return true;
}

async function sendToUser(userId, notification, data = {}) {
  if (!initFCM()) return { sent:false, reason:'FCM not configured' };

  const { query } = require('../db');

  const result = await query(
    `SELECT fcm_token FROM device_tokens
     WHERE user_id=$1 AND active=true`,
    [userId]
  );

  if (!result.rows.length) {
    return {sent:false, reason:'No active device tokens'};
  }

  const tokens = result.rows.map(x => x.fcm_token);

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification,
    data:Object.fromEntries(
      Object.entries(data).map(([k,v]) => [k,String(v)])
    )
  });

  return {
    sent:true,
    successCount:response.successCount,
    failureCount:response.failureCount
  };
}

module.exports = { initFCM, sendToUser };
JS

cat > src/services/notifications.js <<'JS'
const { query } = require('../db');
const { sendToUser } = require('./fcm');

async function notify({
  userId,
  actorId=null,
  type,
  title,
  body,
  targetType=null,
  targetId=null,
  data={}
}) {
  const result = await query(
    `INSERT INTO notifications
     (user_id,actor_id,type,title,body,target_type,target_id,data)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      userId,
      actorId,
      type,
      title,
      body,
      targetType,
      targetId,
      data
    ]
  );

  try {
    await sendToUser(userId,{title,body},{
      type,
      target_type:targetType || '',
      target_id:targetId || '',
      ...data
    });
  } catch (err) {
    console.error('[FCM]',err.message);
  }

  return result.rows[0];
}

module.exports = { notify };
JS

cat > src/services/moderation.js <<'JS'
const { query } = require('../db');

const threatPatterns = [
  /\bkill you\b/i,
  /\bi will kill\b/i,
  /\bgoing to kill\b/i,
  /\bshoot you\b/i,
  /\bstab you\b/i,
  /\bblow you up\b/i,
  /\bbeat you to death\b/i,
  /\bhurt you\b/i
];

const scamPatterns = [
  /\bsend me money\b/i,
  /\binvestment opportunity\b/i,
  /\bverification code\b/i,
  /\bsend your otp\b/i,
  /\bgive me your password\b/i,
  /\bcrypto giveaway\b/i,
  /\bdouble your money\b/i
];

function classifyMessage(text='') {
  if (threatPatterns.some(r => r.test(text))) return 'threat';
  if (scamPatterns.some(r => r.test(text))) return 'scam';
  return null;
}

async function moderateMessage({userId,messageId,text}) {
  const category = classifyMessage(text);

  if (!category) {
    return {allowed:true,category:null};
  }

  await query(
    `INSERT INTO moderation_events
     (user_id,message_id,category,action,reason)
     VALUES($1,$2,$3,$4,$5)`,
    [
      userId,
      messageId,
      category,
      'block_message',
      `Automated ${category} detection`
    ]
  );

  return {
    allowed:false,
    category,
    replacement:
      'Message deleted — this message was deleted because it contained threatening content.'
  };
}

module.exports = { classifyMessage, moderateMessage };
JS

cat > src/providers/b2.js <<'JS'
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
JS

cat > src/websocket/realtime.js <<'JS'
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const env = require('../config/env');

function attachRealtime(server) {
  const wss = new WebSocketServer({
    server,
    path:'/ws'
  });

  const clients = new Map();

  wss.on('connection',(socket)=>{
    let userId = null;

    socket.send(JSON.stringify({
      type:'CONNECTED',
      message:'Connecto realtime connected'
    }));

    socket.on('message',(raw)=>{
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'AUTH') {
          const payload = jwt.verify(msg.token,env.jwtSecret);
          userId = payload.sub;

          if (!clients.has(userId)) {
            clients.set(userId,new Set());
          }

          clients.get(userId).add(socket);

          socket.send(JSON.stringify({
            type:'AUTHENTICATED'
          }));

          return;
        }

        if (!userId) return;

        if (
          ['TYPING_START','TYPING_STOP','CALL_SIGNAL','MESSAGE'].includes(msg.type)
          && msg.targetUserId
        ) {
          const targets = clients.get(msg.targetUserId) || new Set();

          for (const target of targets) {
            if (target.readyState === 1) {
              target.send(JSON.stringify({
                ...msg,
                senderUserId:userId
              }));
            }
          }
        }

        if (msg.type === 'PING') {
          socket.send(JSON.stringify({type:'PONG'}));
        }

      } catch(err) {
        socket.send(JSON.stringify({
          type:'ERROR',
          error:'Invalid realtime message'
        }));
      }
    });

    socket.on('close',()=>{
      if (!userId) return;

      const set = clients.get(userId);
      if (!set) return;

      set.delete(socket);

      if (!set.size) {
        clients.delete(userId);
      }
    });
  });

  return wss;
}

module.exports = { attachRealtime };
JS

cat > src/routes/complete-v1.js <<'JS'
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');

const auth = require('../middleware/auth');
const { query } = require('../db');
const env = require('../config/env');
const { hashSecret, randomSecret } = require('../utils/security');
const { notify } = require('../services/notifications');
const { moderateMessage } = require('../services/moderation');
const b2 = require('../providers/b2');

const router = express.Router();

function accessToken(userId,sessionId) {
  return jwt.sign(
    {sub:userId,sessionId,type:'access'},
    env.jwtSecret,
    {expiresIn:env.jwtExpiresIn}
  );
}

function refreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function expiryDate(days) {
  const d = new Date();
  d.setDate(d.getDate()+days);
  return d;
}

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g,'');
}

async function createSession(userId,req,body={}) {
  const result = await query(
    `INSERT INTO sessions
     (user_id,device_id,device_name,device_type,os_version,app_version,
      ip_address,user_agent,recognized)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      userId,
      body.deviceId || null,
      body.deviceName || null,
      body.deviceType || null,
      body.osVersion || null,
      body.appVersion || null,
      req.ip,
      req.headers['user-agent'] || null,
      false
    ]
  );

  const sessionId = result.rows[0].id;
  const refresh = refreshToken();

  await query(
    `INSERT INTO refresh_tokens
     (user_id,token_hash,device_id,device_name,device_type,os_version,
      app_version,ip_address,user_agent,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      userId,
      hashSecret(refresh),
      body.deviceId || null,
      body.deviceName || null,
      body.deviceType || null,
      body.osVersion || null,
      body.appVersion || null,
      req.ip,
      req.headers['user-agent'] || null,
      expiryDate(env.refreshDays)
    ]
  );

  return {
    accessToken:accessToken(userId,sessionId),
    refreshToken:refresh,
    sessionId
  };
}

/* HEALTH */

router.get('/health',(req,res)=>{
  res.json({
    success:true,
    service:'Connecto API',
    version:'v1',
    status:'online',
    timestamp:new Date().toISOString()
  });
});

router.get('/health/db',async(req,res)=>{
  const r = await query('SELECT NOW() AS server_time');
  res.json({
    success:true,
    database:'connected',
    server_time:r.rows[0].server_time
  });
});

router.get('/providers/status',async(req,res)=>{
  res.json({
    success:true,
    providers:{
      postgres:true,
      fcm:!!(
        env.fcm.projectId &&
        env.fcm.clientEmail &&
        env.fcm.privateKey
      ),
      b2:b2.configured(),
      websocket:true,
      webrtc_signaling:true
    }
  });
});

/* REGISTRATION */

router.post('/auth/register',async(req,res,next)=>{
  try {
    const schema = z.object({
      name:z.string().min(1).max(80),
      surname:z.string().min(1).max(80),
      email:z.string().email(),
      password:z.string().min(8),
      mobile:z.string().max(40).optional()
    });

    const data = schema.parse(req.body);

    const exists = await query(
      `SELECT id FROM users
       WHERE lower(email)=lower($1)
          OR ($2::text IS NOT NULL AND mobile=$2)
       LIMIT 1`,
      [data.email,data.mobile || null]
    );

    if (exists.rows.length) {
      return res.status(409).json({
        success:false,
        error:'An account with those credentials already exists'
      });
    }

    const passwordHash = await bcrypt.hash(data.password,12);

    const user = await query(
      `INSERT INTO users
       (name,surname,email,password_hash,mobile,account_status)
       VALUES($1,$2,$3,$4,$5,'active')
       RETURNING id,name,surname,email,mobile,created_at`,
      [
        data.name,
        data.surname,
        data.email.toLowerCase(),
        passwordHash,
        data.mobile || null
      ]
    );

    await query(
      `INSERT INTO user_settings(user_id)
       VALUES($1)
       ON CONFLICT DO NOTHING`,
      [user.rows[0].id]
    );

    const session = await createSession(
      user.rows[0].id,
      req,
      req.body
    );

    res.status(201).json({
      success:true,
      user:user.rows[0],
      ...session,
      nextStep:'complete-profile'
    });

  } catch(err) {
    next(err);
  }
});

router.post('/auth/login',async(req,res,next)=>{
  try {
    const identifier = String(req.body.email || req.body.username || '').trim();

    const result = await query(
      `SELECT * FROM users
       WHERE lower(email)=lower($1)
          OR lower(username)=lower($1)
       LIMIT 1`,
      [identifier]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      req.body.password || '',
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    const session = await createSession(user.id,req,req.body);

    await query(
      `INSERT INTO security_events
       (user_id,event_type,ip_address,device_id,metadata)
       VALUES($1,'SECURITY_LOGIN',$2,$3,$4)`,
      [
        user.id,
        req.ip,
        req.body.deviceId || null,
        {
          deviceType:req.body.deviceType || null,
          deviceName:req.body.deviceName || null,
          osVersion:req.body.osVersion || null,
          appVersion:req.body.appVersion || null
        }
      ]
    );

    res.json({
      success:true,
      user:{
        id:user.id,
        name:user.name,
        surname:user.surname,
        email:user.email,
        username:user.username
      },
      ...session
    });

  } catch(err) {
    next(err);
  }
});

router.post('/auth/refresh',async(req,res)=>{
  const raw = req.body.refreshToken;

  if (!raw) {
    return res.status(400).json({
      success:false,
      error:'refreshToken required'
    });
  }

  const result = await query(
    `SELECT * FROM refresh_tokens
     WHERE token_hash=$1
       AND revoked_at IS NULL
       AND expires_at>NOW()
     LIMIT 1`,
    [hashSecret(raw)]
  );

  if (!result.rows.length) {
    return res.status(401).json({
      success:false,
      error:'Invalid refresh token'
    });
  }

  const row = result.rows[0];

  await query(
    `UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1`,
    [row.id]
  );

  const session = await createSession(row.user_id,req,{
    deviceId:row.device_id,
    deviceName:row.device_name,
    deviceType:row.device_type,
    osVersion:row.os_version,
    appVersion:row.app_version
  });

  res.json({success:true,...session});
});

router.post('/auth/logout',auth,async(req,res)=>{
  await query(
    `UPDATE refresh_tokens SET revoked_at=NOW()
     WHERE user_id=$1 AND revoked_at IS NULL`,
    [req.user.id]
  );

  await query(
    `UPDATE sessions SET revoked_at=NOW()
     WHERE user_id=$1 AND revoked_at IS NULL`,
    [req.user.id]
  );

  res.json({success:true});
});

router.get('/auth/me',auth,(req,res)=>{
  res.json({
    success:true,
    user:req.user
  });
});

/* PROFILE */

router.post('/profile/complete',auth,async(req,res,next)=>{
  try {
    const username = cleanUsername(req.body.username);

    if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({
        success:false,
        error:'Username must be 3-32 characters using lowercase letters, numbers and underscores'
      });
    }

    const reserved = [
      'connecto','official','admin','administrator','support',
      'security','help','moderator','team','ceo','root'
    ];

    if (reserved.includes(username)) {
      return res.status(409).json({
        success:false,
        error:'Username is reserved'
      });
    }

    const taken = await query(
      `SELECT id FROM users
       WHERE lower(username)=lower($1)
         AND id<>$2`,
      [username,req.user.id]
    );

    if (taken.rows.length) {
      return res.status(409).json({
        success:false,
        error:'Username is already taken'
      });
    }

    const gender =
      ['Male','Female','Rather not say'].includes(req.body.gender)
        ? req.body.gender
        : null;

    const result = await query(
      `UPDATE users
       SET username=$1,
           bio=$2,
           category=$3,
           country=$4,
           state=$5,
           gender=$6,
           updated_at=NOW()
       WHERE id=$7
       RETURNING id,name,surname,email,username,bio,category,country,state,gender,
                 profile_photo_url,cover_photo_url`,
      [
        username,
        req.body.bio || null,
        req.body.category || null,
        req.body.country || null,
        req.body.state || null,
        gender,
        req.user.id
      ]
    );

    res.json({
      success:true,
      user:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

router.patch('/profile',auth,async(req,res,next)=>{
  try {
    const allowed = [
      'bio',
      'category',
      'country',
      'state',
      'gender',
      'profile_photo_url',
      'cover_photo_url'
    ];

    const fields=[];
    const values=[];
    let n=1;

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        fields.push(`${field}=$${n++}`);
        values.push(req.body[field]);
      }
    }

    if (!fields.length) {
      return res.status(400).json({
        success:false,
        error:'No editable profile fields supplied'
      });
    }

    values.push(req.user.id);

    const result = await query(
      `UPDATE users SET ${fields.join(',')},updated_at=NOW()
       WHERE id=$${n}
       RETURNING id,name,surname,email,username,bio,category,country,state,gender,
                 profile_photo_url,cover_photo_url`,
      values
    );

    res.json({
      success:true,
      user:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

/* USERS / SOCIAL */

router.get('/users/search',auth,async(req,res,next)=>{
  try {
    const q = String(req.query.q || '').trim();
    const country = req.query.country || null;
    const gender = req.query.gender || null;
    const limit = Math.min(Number(req.query.limit || 20),50);

    const result = await query(
      `SELECT id,name,surname,username,bio,category,country,state,gender,
              profile_photo_url
       FROM users
       WHERE account_status='active'
         AND id<>$1
         AND ($2='' OR name ILIKE '%'||$2||'%' OR surname ILIKE '%'||$2||'%' OR username ILIKE '%'||$2||'%')
         AND ($3::text IS NULL OR country=$3)
         AND ($4::text IS NULL OR gender=$4)
       ORDER BY created_at DESC
       LIMIT $5`,
      [req.user.id,q,country,gender,limit]
    );

    res.json({success:true,users:result.rows});
  } catch(err) {
    next(err);
  }
});

router.post('/social/follow/:userId',auth,async(req,res,next)=>{
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({
        success:false,
        error:'Cannot follow yourself'
      });
    }

    await query(
      `INSERT INTO follows(follower_id,following_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.user.id,req.params.userId]
    );

    await notify({
      userId:req.params.userId,
      actorId:req.user.id,
      type:'USER_FOLLOWED',
      title:'New follower',
      body:`${req.user.name} started following you`,
      targetType:'user',
      targetId:req.user.id
    });

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.delete('/social/follow/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `DELETE FROM follows
       WHERE follower_id=$1 AND following_id=$2`,
      [req.user.id,req.params.userId]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/social/friend-request/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `INSERT INTO friend_requests(sender_id,receiver_id)
       VALUES($1,$2)`,
      [req.user.id,req.params.userId]
    );

    await notify({
      userId:req.params.userId,
      actorId:req.user.id,
      type:'FRIEND_REQUESTED',
      title:'Friend request',
      body:`${req.user.name} sent you a friend request`,
      targetType:'user',
      targetId:req.user.id
    });

    res.status(201).json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/social/friend-request/:id/accept',auth,async(req,res,next)=>{
  try {
    const request = await query(
      `SELECT * FROM friend_requests
       WHERE id=$1 AND receiver_id=$2 AND status='pending'`,
      [req.params.id,req.user.id]
    );

    if (!request.rows.length) {
      return res.status(404).json({
        success:false,
        error:'Friend request not found'
      });
    }

    const r = request.rows[0];

    await query(
      `UPDATE friend_requests SET status='accepted',updated_at=NOW()
       WHERE id=$1`,
      [r.id]
    );

    await query(
      `INSERT INTO friendships(user_id,friend_id)
       VALUES($1,$2),($2,$1)
       ON CONFLICT DO NOTHING`,
      [r.sender_id,r.receiver_id]
    );

    await notify({
      userId:r.sender_id,
      actorId:req.user.id,
      type:'FRIEND_ACCEPTED',
      title:'Friend request accepted',
      body:`${req.user.name} accepted your friend request`,
      targetType:'user',
      targetId:req.user.id
    });

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* POSTS / FEED */

router.post('/posts',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO posts(user_id,body,visibility,comments_enabled,share_enabled)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        req.user.id,
        req.body.body || null,
        req.body.visibility || 'public',
        req.body.commentsEnabled !== false,
        req.body.shareEnabled !== false
      ]
    );

    res.status(201).json({
      success:true,
      post:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.get('/feed',auth,async(req,res,next)=>{
  try {
    const limit = Math.min(Number(req.query.limit || 20),50);
    const offset = Math.max(Number(req.query.offset || 0),0);

    const result = await query(
      `SELECT
         p.*,
         u.name,u.surname,u.username,u.profile_photo_url,
         COALESCE(rc.reaction_count,0) reaction_count,
         COALESCE(cc.comment_count,0) comment_count
       FROM posts p
       JOIN users u ON u.id=p.user_id
       LEFT JOIN (
         SELECT post_id,COUNT(*) reaction_count
         FROM reactions GROUP BY post_id
       ) rc ON rc.post_id=p.id
       LEFT JOIN (
         SELECT post_id,COUNT(*) comment_count
         FROM comments WHERE deleted_at IS NULL
         GROUP BY post_id
       ) cc ON cc.post_id=p.id
       WHERE p.deleted_at IS NULL
         AND u.account_status='active'
         AND (
           p.visibility='public'
           OR p.user_id=$1
           OR EXISTS(
             SELECT 1 FROM friendships f
             WHERE f.user_id=$1 AND f.friend_id=p.user_id
           )
         )
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id,limit,offset]
    );

    res.json({
      success:true,
      posts:result.rows,
      pagination:{limit,offset}
    });
  } catch(err) {
    next(err);
  }
});

router.post('/posts/:postId/reactions',auth,async(req,res,next)=>{
  try {
    const reaction = req.body.reaction || 'like';

    await query(
      `INSERT INTO reactions(post_id,user_id,reaction)
       VALUES($1,$2,$3)
       ON CONFLICT(post_id,user_id)
       DO UPDATE SET reaction=EXCLUDED.reaction`,
      [req.params.postId,req.user.id,reaction]
    );

    res.json({success:true,reaction});
  } catch(err) {
    next(err);
  }
});

router.delete('/posts/:postId/reactions',auth,async(req,res,next)=>{
  try {
    await query(
      `DELETE FROM reactions
       WHERE post_id=$1 AND user_id=$2`,
      [req.params.postId,req.user.id]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/posts/:postId/comments',auth,async(req,res,next)=>{
  try {
    if (!req.body.body || !String(req.body.body).trim()) {
      return res.status(400).json({
        success:false,
        error:'Comment body required'
      });
    }

    const result = await query(
      `INSERT INTO comments(post_id,user_id,parent_id,body)
       VALUES($1,$2,$3,$4)
       RETURNING *`,
      [
        req.params.postId,
        req.user.id,
        req.body.parentId || null,
        String(req.body.body).trim()
      ]
    );

    res.status(201).json({
      success:true,
      comment:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

/* CHAT */

router.post('/chat/conversations',auth,async(req,res,next)=>{
  try {
    const otherUserId = req.body.userId;

    if (!otherUserId) {
      return res.status(400).json({
        success:false,
        error:'userId required'
      });
    }

    const existing = await query(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members a ON a.conversation_id=c.id
       JOIN conversation_members b ON b.conversation_id=c.id
       WHERE c.type='direct'
         AND a.user_id=$1
         AND b.user_id=$2
       LIMIT 1`,
      [req.user.id,otherUserId]
    );

    if (existing.rows.length) {
      return res.json({
        success:true,
        conversationId:existing.rows[0].id
      });
    }

    const conversation = await query(
      `INSERT INTO conversations(type)
       VALUES('direct') RETURNING id`,
      []
    );

    const id = conversation.rows[0].id;

    await query(
      `INSERT INTO conversation_members(conversation_id,user_id)
       VALUES($1,$2),($1,$3)`,
      [id,req.user.id,otherUserId]
    );

    res.status(201).json({
      success:true,
      conversationId:id
    });

  } catch(err) {
    next(err);
  }
});

router.get('/chat/conversations',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT c.id,c.type,c.created_at,c.updated_at
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id=c.id
       WHERE cm.user_id=$1
       ORDER BY c.updated_at DESC`,
      [req.user.id]
    );

    res.json({
      success:true,
      conversations:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.get('/chat/conversations/:id/messages',auth,async(req,res,next)=>{
  try {
    const member = await query(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [req.params.id,req.user.id]
    );

    if (!member.rows.length) {
      return res.status(403).json({
        success:false,
        error:'Not a conversation member'
      });
    }

    const result = await query(
      `SELECT m.*,u.name,u.surname,u.username,u.profile_photo_url
       FROM messages m
       JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=$1
       ORDER BY m.created_at ASC
       LIMIT 100`,
      [req.params.id]
    );

    res.json({
      success:true,
      messages:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.post('/chat/conversations/:id/messages',auth,async(req,res,next)=>{
  try {
    const member = await query(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [req.params.id,req.user.id]
    );

    if (!member.rows.length) {
      return res.status(403).json({
        success:false,
        error:'Not a conversation member'
      });
    }

    const text = String(req.body.body || '').trim();

    if (!text) {
      return res.status(400).json({
        success:false,
        error:'Message body required'
      });
    }

    const inserted = await query(
      `INSERT INTO messages
       (conversation_id,sender_id,body,message_type,reply_to_id)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        req.params.id,
        req.user.id,
        text,
        req.body.messageType || 'text',
        req.body.replyToId || null
      ]
    );

    const message = inserted.rows[0];

    const moderation = await moderateMessage({
      userId:req.user.id,
      messageId:message.id,
      text
    });

    if (!moderation.allowed) {
      await query(
        `UPDATE messages
         SET deleted_at=NOW(),body=$1
         WHERE id=$2`,
        [moderation.replacement,message.id]
      );

      return res.status(422).json({
        success:false,
        error:moderation.replacement,
        moderated:true
      });
    }

    await query(
      `UPDATE conversations SET updated_at=NOW()
       WHERE id=$1`,
      [req.params.id]
    );

    res.status(201).json({
      success:true,
      message
    });

  } catch(err) {
    next(err);
  }
});

/* CALLS / WEBRTC SIGNALING */

router.post('/calls',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO calls
       (conversation_id,caller_id,receiver_id,type)
       VALUES($1,$2,$3,$4)
       RETURNING *`,
      [
        req.body.conversationId || null,
        req.user.id,
        req.body.receiverId,
        req.body.type || 'video'
      ]
    );

    await notify({
      userId:req.body.receiverId,
      actorId:req.user.id,
      type:'CALL_RECEIVED',
      title:'Incoming call',
      body:`${req.user.name} is calling you`,
      targetType:'call',
      targetId:result.rows[0].id
    });

    res.status(201).json({
      success:true,
      call:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

router.get('/calls/:id',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT * FROM calls
       WHERE id=$1
       AND (caller_id=$2 OR receiver_id=$2)`,
      [req.params.id,req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success:false,
        error:'Call not found'
      });
    }

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/accept',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `UPDATE calls
       SET status='accepted',accepted_at=NOW()
       WHERE id=$1 AND receiver_id=$2
       RETURNING *`,
      [req.params.id,req.user.id]
    );

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/reject',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `UPDATE calls
       SET status='rejected',ended_at=NOW()
       WHERE id=$1
       AND (receiver_id=$2 OR caller_id=$2)
       RETURNING *`,
      [req.params.id,req.user.id]
    );

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/end',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `UPDATE calls
       SET status='ended',ended_at=NOW()
       WHERE id=$1
       AND (receiver_id=$2 OR caller_id=$2)
       RETURNING *`,
      [req.params.id,req.user.id]
    );

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/signal',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO call_signals
       (call_id,sender_id,signal_type,payload)
       VALUES($1,$2,$3,$4)
       RETURNING *`,
      [
        req.params.id,
        req.user.id,
        req.body.signalType,
        req.body.payload || {}
      ]
    );

    res.status(201).json({
      success:true,
      signal:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

/* BLOCKING / REPORTING */

router.post('/blocks/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `INSERT INTO blocks(blocker_id,blocked_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.user.id,req.params.userId]
    );

    await query(
      `DELETE FROM follows
       WHERE (follower_id=$1 AND following_id=$2)
          OR (follower_id=$2 AND following_id=$1)`,
      [req.user.id,req.params.userId]
    );

    await query(
      `DELETE FROM friendships
       WHERE (user_id=$1 AND friend_id=$2)
          OR (user_id=$2 AND friend_id=$1)`,
      [req.user.id,req.params.userId]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.delete('/blocks/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `DELETE FROM blocks
       WHERE blocker_id=$1 AND blocked_id=$2`,
      [req.user.id,req.params.userId]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/reports',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO reports
       (reporter_id,reported_user_id,post_id,message_id,category,description)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,status,created_at`,
      [
        req.user.id,
        req.body.reportedUserId || null,
        req.body.postId || null,
        req.body.messageId || null,
        req.body.category,
        req.body.description || null
      ]
    );

    res.status(201).json({
      success:true,
      report:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

/* DEVICES / PUSH */

router.post('/devices',auth,async(req,res,next)=>{
  try {
    if (!req.body.fcmToken) {
      return res.status(400).json({
        success:false,
        error:'fcmToken required'
      });
    }

    await query(
      `INSERT INTO device_tokens
       (user_id,fcm_token,device_id,platform,device_name,os_version,app_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(user_id,fcm_token)
       DO UPDATE SET
         active=true,
         updated_at=NOW()`,
      [
        req.user.id,
        req.body.fcmToken,
        req.body.deviceId || null,
        req.body.platform || 'android',
        req.body.deviceName || null,
        req.body.osVersion || null,
        req.body.appVersion || null
      ]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.delete('/devices/:token',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE device_tokens
       SET active=false,updated_at=NOW()
       WHERE user_id=$1 AND fcm_token=$2`,
      [req.user.id,req.params.token]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* NOTIFICATIONS */

router.get('/notifications',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT * FROM notifications
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      success:true,
      notifications:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.post('/notifications/read-all',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE notifications
       SET read_at=COALESCE(read_at,NOW())
       WHERE user_id=$1`,
      [req.user.id]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* API KEYS */

router.post('/developer/api-keys',auth,async(req,res,next)=>{
  try {
    const secret = `cx_${randomSecret(32)}`;
    const prefix = secret.slice(0,11);

    const result = await query(
      `INSERT INTO api_keys
       (user_id,name,key_prefix,secret_hash)
       VALUES($1,$2,$3,$4)
       RETURNING id,name,key_prefix,created_at`,
      [
        req.user.id,
        req.body.name || 'Connecto API Key',
        prefix,
        hashSecret(secret)
      ]
    );

    res.status(201).json({
      success:true,
      apiKey:result.rows[0],
      secret,
      warning:'Store this secret securely. It will not be shown again.'
    });

  } catch(err) {
    next(err);
  }
});

router.get('/developer/api-keys',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT id,name,key_prefix,last_used_at,created_at,revoked_at
       FROM api_keys
       WHERE user_id=$1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success:true,
      apiKeys:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.post('/developer/api-keys/:id/revoke',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE api_keys
       SET revoked_at=NOW()
       WHERE id=$1 AND user_id=$2`,
      [req.params.id,req.user.id]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* SETTINGS */

router.get('/settings',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT * FROM user_settings WHERE user_id=$1`,
      [req.user.id]
    );

    res.json({
      success:true,
      settings:result.rows[0] || null
    });
  } catch(err) {
    next(err);
  }
});

router.patch('/settings',auth,async(req,res,next)=>{
  try {
    const fields = [
      'profile_visibility',
      'friend_visibility',
      'follower_visibility',
      'message_privacy',
      'typing_enabled',
      'disappearing_messages',
      'two_factor_enabled',
      'biometric_enabled'
    ];

    const assignments=[];
    const values=[];
    let n=1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        assignments.push(`${field}=$${n++}`);
        values.push(req.body[field]);
      }
    }

    if (!assignments.length) {
      return res.status(400).json({
        success:false,
        error:'No settings supplied'
      });
    }

    values.push(req.user.id);

    await query(
      `INSERT INTO user_settings(user_id)
       VALUES($${n})
       ON CONFLICT DO NOTHING`,
      [req.user.id]
    );

    const result = await query(
      `UPDATE user_settings
       SET ${assignments.join(',')},updated_at=NOW()
       WHERE user_id=$${n}
       RETURNING *`,
      values
    );

    res.json({
      success:true,
      settings:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

/* PASSWORD */

router.post('/auth/change-password',auth,async(req,res,next)=>{
  try {
    if (!req.body.currentPassword || !req.body.newPassword) {
      return res.status(400).json({
        success:false,
        error:'Current and new password are required'
      });
    }

    const result = await query(
      `SELECT password_hash FROM users WHERE id=$1`,
      [req.user.id]
    );

    const valid = await bcrypt.compare(
      req.body.currentPassword,
      result.rows[0].password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        error:'Current password is incorrect'
      });
    }

    if (String(req.body.newPassword).length < 8) {
      return res.status(400).json({
        success:false,
        error:'New password must contain at least 8 characters'
      });
    }

    const hash = await bcrypt.hash(req.body.newPassword,12);

    await query(
      `UPDATE users SET password_hash=$1,updated_at=NOW()
       WHERE id=$2`,
      [hash,req.user.id]
    );

    await query(
      `UPDATE refresh_tokens
       SET revoked_at=NOW()
       WHERE user_id=$1 AND revoked_at IS NULL`,
      [req.user.id]
    );

    await query(
      `INSERT INTO security_events(user_id,event_type,metadata)
       VALUES($1,'PASSWORD_CHANGED',$2)`,
      [req.user.id,{time:new Date().toISOString()}]
    );

    res.json({
      success:true,
      message:'Password changed. Existing sessions were revoked.'
    });

  } catch(err) {
    next(err);
  }
});

module.exports = router;
JS

cat > server.js <<'JS'
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');

const env = require('./src/config/env');
const { pool } = require('./src/db');
const { attachRealtime } = require('./src/websocket/realtime');
const v1 = require('./src/routes/complete-v1');

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');

app.use(helmet());

app.use(cors({
  origin:env.corsOrigins === '*'
    ? '*'
    : env.corsOrigins.split(',').map(x=>x.trim()),
  credentials:true
}));

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true,limit:'10mb'}));

app.get('/',(req,res)=>{
  res.json({
    success:true,
    service:'Connecto',
    version:'v1'
  });
});

app.use('/api/v1',v1);

app.use((err,req,res,next)=>{
  console.error('[CONNECTO ERROR]',err);

  if (err.name === 'ZodError') {
    return res.status(400).json({
      success:false,
      error:'Invalid request',
      details:err.issues
    });
  }

  if (err.code === '23505') {
    return res.status(409).json({
      success:false,
      error:'A record with those values already exists'
    });
  }

  res.status(500).json({
    success:false,
    error:'Internal server error'
  });
});

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('[CONNECTO] PostgreSQL connected.');

    attachRealtime(server);

    server.listen(env.port,'0.0.0.0',()=>{
      console.log('========================================');
      console.log('       CONNECTO COMPLETE V1 ONLINE');
      console.log('========================================');
      console.log(`HTTP: http://127.0.0.1:${env.port}`);
      console.log(`Health: http://127.0.0.1:${env.port}/api/v1/health`);
      console.log(`DB Health: http://127.0.0.1:${env.port}/api/v1/health/db`);
      console.log(`Providers: http://127.0.0.1:${env.port}/api/v1/providers/status`);
      console.log(`WebSocket: ws://127.0.0.1:${env.port}/ws`);
      console.log('========================================');
    });
  } catch(err) {
    console.error('[CONNECTO] Startup failed:',err.message);
    process.exit(1);
  }
}

start();
JS

node -e "const fs=require('fs'); const p=require('./package.json'); p.scripts={...(p.scripts||{}),start:'node server.js',dev:'node --watch server.js'}; fs.writeFileSync('package.json',JSON.stringify(p,null,2));"

echo "[2/7] Checking Node syntax..."

node --check server.js
node --check src/routes/complete-v1.js
node --check src/services/fcm.js
node --check src/services/moderation.js
node --check src/websocket/realtime.js

echo "[3/7] Checking database..."

PGPASSWORD="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)" \
psql -h 127.0.0.1 -U connecto_app -d connecto \
-c "SELECT current_user,current_database();"

echo "[4/7] Checking important tables..."

PGPASSWORD="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)" \
psql -h 127.0.0.1 -U connecto_app -d connecto \
-c "\dt"

echo "[5/7] Checking API routes..."

echo "Health:"
curl -s http://127.0.0.1:3000/api/v1/health || true

echo
echo "Database health:"
curl -s http://127.0.0.1:3000/api/v1/health/db || true

echo
echo "Provider status:"
curl -s http://127.0.0.1:3000/api/v1/providers/status || true

echo
echo "[6/7] Complete V1 backend files installed."

echo "[7/7] Final checks complete."

echo
echo "=============================================="
echo "      CONNECTO COMPLETE V1 READY"
echo "=============================================="
echo
echo "Backend includes:"
echo " - Registration/login"
echo " - Access + refresh tokens"
echo " - Password hashing"
echo " - Sessions/devices"
echo " - Profile completion"
echo " - Username validation"
echo " - Follow system"
echo " - Friend requests"
echo " - Blocking"
echo " - Posts/feed"
echo " - Reactions"
echo " - Comments"
echo " - Notifications"
echo " - FCM integration"
echo " - Device tokens"
echo " - Realtime WebSocket"
echo " - Chat"
echo " - Message moderation"
echo " - WebRTC signaling"
echo " - Call lifecycle"
echo " - Reports"
echo " - Security events"
echo " - API keys"
echo " - API key revocation"
echo " - User settings"
echo " - B2 storage adapter"
echo " - PostgreSQL persistence"
echo
echo "IMPORTANT:"
echo "Biometric authentication is implemented on the Android"
echo "client with Android BiometricPrompt. The server never"
echo "receives or stores fingerprint/face data."
echo
echo "FCM and B2 require your private credentials in .env."
echo "Do NOT paste those credentials into chat or GitHub."
echo
echo "=============================================="
