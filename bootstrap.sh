#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "========================================"
echo "       CONNECTO V1 BACKEND SETUP"
echo "========================================"

mkdir -p src/config src/db src/middleware src/routes src/controllers \
  src/services src/models src/utils src/providers src/websocket src/jobs \
  src/modules

cat > .gitignore <<'GITEOF'
.env
.env.*
!.env.example
node_modules/
*.log
.DS_Store
GITEOF

cat > .env.example <<'ENVEOF'
NODE_ENV=development
PORT=3000
APP_NAME=Connecto
API_VERSION=v1

# PostgreSQL
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=connecto
DB_USER=connecto_app
DB_PASSWORD=CHANGE_ME
DB_SSL=false
DB_POOL_MAX=10

# Authentication
JWT_SECRET=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_DAYS=30

# Backblaze B2 / S3-compatible API
B2_ENDPOINT=
B2_REGION=eu-central-003
B2_BUCKET=connecto-media-prod
B2_KEY_ID=
B2_APPLICATION_KEY=

# Firebase Cloud Messaging
FCM_PROJECT_ID=
FCM_CLIENT_EMAIL=
FCM_PRIVATE_KEY=

# CORS
CORS_ORIGINS=*

# Upload limits
MAX_IMAGE_SIZE_MB=15
MAX_VIDEO_SIZE_MB=500

# WebSocket
WS_ENABLED=true
ENVEOF

if [ ! -f .env ]; then
  cp .env.example .env
fi

cat > src/config/env.js <<'JSEOF'
require("dotenv").config();

const required = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "JWT_SECRET"
];

for (const key of required) {
  if (!process.env[key] || process.env[key] === "CHANGE_ME") {
    console.warn(`[CONFIG] ${key} is not configured.`);
  }
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  appName: process.env.APP_NAME || "Connecto",
  apiVersion: process.env.API_VERSION || "v1",

  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || "connecto",
    user: process.env.DB_USER || "connecto_app",
    password: process.env.DB_PASSWORD || "",
    ssl: process.env.DB_SSL === "true",
    max: Number(process.env.DB_POOL_MAX || 10)
  },

  jwt: {
    secret: process.env.JWT_SECRET || "",
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
    refreshDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 30)
  },

  b2: {
    endpoint: process.env.B2_ENDPOINT || "",
    region: process.env.B2_REGION || "eu-central-003",
    bucket: process.env.B2_BUCKET || "",
    keyId: process.env.B2_KEY_ID || "",
    applicationKey: process.env.B2_APPLICATION_KEY || ""
  },

  fcm: {
    projectId: process.env.FCM_PROJECT_ID || "",
    clientEmail: process.env.FCM_CLIENT_EMAIL || "",
    privateKey: process.env.FCM_PRIVATE_KEY
      ? process.env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n")
      : ""
  },

  corsOrigins: process.env.CORS_ORIGINS || "*"
};
JSEOF

cat > src/db/index.js <<'JSEOF'
const { Pool } = require("pg");
const config = require("../config/env");

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: config.db.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on("error", (err) => {
  console.error("[POSTGRES]", err.message);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function healthCheck() {
  const result = await pool.query("SELECT NOW() AS now");
  return result.rows[0];
}

module.exports = {
  pool,
  query,
  healthCheck
};
JSEOF

cat > src/middleware/auth.js <<'JSEOF'
const jwt = require("jsonwebtoken");
const config = require("../config/env");

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "AUTHENTICATION_REQUIRED"
    });
  }

  const token = header.substring(7);

  try {
    const payload = jwt.verify(token, config.jwt.secret);

    req.user = {
      id: payload.sub,
      email: payload.email
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: "INVALID_OR_EXPIRED_TOKEN"
    });
  }
}

module.exports = { authenticate };
JSEOF

cat > src/middleware/error.js <<'JSEOF'
function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    path: req.originalUrl,
    request_id: req.requestId
  });
}

function errorHandler(err, req, res, next) {
  console.error("[ERROR]", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    error: err.code || "SERVER_ERROR",
    message:
      process.env.NODE_ENV === "production"
        ? "An unexpected server error occurred."
        : err.message,
    request_id: req.requestId
  });
}

module.exports = {
  notFound,
  errorHandler
};
JSEOF

cat > src/utils/requestId.js <<'JSEOF'
const crypto = require("crypto");

function requestId(req, res, next) {
  const id = crypto.randomUUID();

  req.requestId = id;
  res.setHeader("X-Request-ID", id);

  next();
}

module.exports = requestId;
JSEOF

cat > src/services/notifications.js <<'JSEOF'
const { query } = require("../db");

async function createNotification({
  recipientId,
  actorId = null,
  type,
  title,
  body,
  targetType = null,
  targetId = null,
  data = {}
}) {
  const result = await query(
    `INSERT INTO notifications
      (recipient_id, actor_id, type, title, body, target_type, target_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      recipientId,
      actorId,
      type,
      title,
      body,
      targetType,
      targetId,
      JSON.stringify(data)
    ]
  );

  return result.rows[0];
}

module.exports = { createNotification };
JSEOF

cat > src/providers/b2.js <<'JSEOF'
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
  getSignedUrl
} = require("@aws-sdk/s3-request-presigner");

const config = require("../config/env");

function configured() {
  return Boolean(
    config.b2.endpoint &&
    config.b2.bucket &&
    config.b2.keyId &&
    config.b2.applicationKey
  );
}

function client() {
  if (!configured()) {
    throw new Error("Backblaze B2 storage is not configured");
  }

  return new S3Client({
    endpoint: config.b2.endpoint,
    region: config.b2.region,
    credentials: {
      accessKeyId: config.b2.keyId,
      secretAccessKey: config.b2.applicationKey
    },
    forcePathStyle: true
  });
}

async function createUploadUrl(key, contentType) {
  const command = new PutObjectCommand({
    Bucket: config.b2.bucket,
    Key: key,
    ContentType: contentType
  });

  return getSignedUrl(client(), command, {
    expiresIn: 900
  });
}

async function createDownloadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.b2.bucket,
    Key: key
  });

  return getSignedUrl(client(), command, {
    expiresIn: 900
  });
}

module.exports = {
  configured,
  createUploadUrl,
  createDownloadUrl
};
JSEOF

cat > src/providers/fcm.js <<'JSEOF'
const admin = require("firebase-admin");
const config = require("../config/env");

let initialized = false;

function initialize() {
  if (initialized) return true;

  if (
    !config.fcm.projectId ||
    !config.fcm.clientEmail ||
    !config.fcm.privateKey
  ) {
    return false;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: config.fcm.projectId,
      clientEmail: config.fcm.clientEmail,
      privateKey: config.fcm.privateKey
    })
  });

  initialized = true;
  return true;
}

async function sendPush(token, notification, data = {}) {
  if (!initialize()) {
    return {
      sent: false,
      reason: "FCM_NOT_CONFIGURED"
    };
  }

  const response = await admin.messaging().send({
    token,
    notification,
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    )
  });

  return {
    sent: true,
    messageId: response
  };
}

module.exports = {
  initialize,
  sendPush
};
JSEOF

cat > src/routes/health.js <<'JSEOF'
const express = require("express");
const { healthCheck } = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  res.json({
    success: true,
    service: "Connecto API",
    version: "v1",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

router.get("/db", async (req, res) => {
  try {
    const result = await healthCheck();

    res.json({
      success: true,
      database: "connected",
      server_time: result.now
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      database: "unavailable",
      error: error.message
    });
  }
});

module.exports = router;
JSEOF

cat > src/routes/auth.js <<'JSEOF'
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const { query } = require("../db");
const config = require("../config/env");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128)
});

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email
    },
    config.jwt.secret,
    {
      expiresIn: config.jwt.expiresIn
    }
  );
}

router.post("/register", async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);

    const existing = await query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [input.email]
    );

    if (existing.rowCount) {
      return res.status(409).json({
        success: false,
        error: "EMAIL_ALREADY_EXISTS"
      });
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const result = await query(
      `INSERT INTO users
       (name, surname, email, password_hash)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, surname, email, username, created_at`,
      [
        input.name,
        input.surname,
        input.email,
        passwordHash
      ]
    );

    const user = result.rows[0];

    res.status(201).json({
      success: true,
      user,
      token: signToken(user)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await query(
      `SELECT id,name,surname,email,username,password_hash
       FROM users
       WHERE LOWER(email)=LOWER($1)
       AND deleted_at IS NULL`,
      [email]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        success: false,
        error: "INVALID_CREDENTIALS"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        success: false,
        error: "INVALID_CREDENTIALS"
      });
    }

    delete user.password_hash;

    res.json({
      success: true,
      user,
      token: signToken(user)
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id,name,surname,email,username,bio,category,
              country,state,gender,profile_photo_url,cover_photo_url,
              created_at
       FROM users
       WHERE id=$1 AND deleted_at IS NULL`,
      [req.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "USER_NOT_FOUND"
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", authenticate, async (req, res) => {
  res.json({
    success: true,
    message: "Logout acknowledged. Client should discard its access token."
  });
});

module.exports = router;
JSEOF

cat > src/routes/users.js <<'JSEOF'
const express = require("express");
const { z } = require("zod");

const { query } = require("../db");
const { authenticate } = require("../middleware/auth");
const { createNotification } = require("../services/notifications");

const router = express.Router();

router.get("/:userId", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id,name,surname,username,bio,category,country,state,
              gender,profile_photo_url,cover_photo_url,created_at
       FROM users
       WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "USER_NOT_FOUND"
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.put("/me/profile", authenticate, async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      surname: z.string().trim().min(1).max(100).optional(),
      bio: z.string().max(1000).optional(),
      category: z.string().max(100).optional(),
      country: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      gender: z.enum(["Male", "Female", "Rather not say"]).optional()
    });

    const data = schema.parse(req.body);

    const result = await query(
      `UPDATE users SET
       name=COALESCE($1,name),
       surname=COALESCE($2,surname),
       bio=COALESCE($3,bio),
       category=COALESCE($4,category),
       country=COALESCE($5,country),
       state=COALESCE($6,state),
       gender=COALESCE($7,gender),
       updated_at=NOW()
       WHERE id=$8
       RETURNING id,name,surname,email,username,bio,category,country,state,gender`,
      [
        data.name ?? null,
        data.surname ?? null,
        data.bio ?? null,
        data.category ?? null,
        data.country ?? null,
        data.state ?? null,
        data.gender ?? null,
        req.user.id
      ]
    );

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:userId/follow", authenticate, async (req, res, next) => {
  try {
    const targetId = req.params.userId;

    if (targetId === req.user.id) {
      return res.status(400).json({
        success: false,
        error: "CANNOT_FOLLOW_SELF"
      });
    }

    await query(
      `INSERT INTO follows (follower_id, following_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, targetId]
    );

    await createNotification({
      recipientId: targetId,
      actorId: req.user.id,
      type: "USER_FOLLOWED",
      title: "New follower",
      body: "Someone followed you.",
      targetType: "profile",
      targetId: req.user.id
    });

    res.status(201).json({
      success: true,
      following: true
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:userId/follow", authenticate, async (req, res, next) => {
  try {
    await query(
      `DELETE FROM follows
       WHERE follower_id=$1 AND following_id=$2`,
      [req.user.id, req.params.userId]
    );

    res.json({
      success: true,
      following: false
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
JSEOF

cat > src/routes/posts.js <<'JSEOF'
const express = require("express");
const { z } = require("zod");

const { query } = require("../db");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.post("/", authenticate, async (req, res, next) => {
  try {
    const schema = z.object({
      text: z.string().max(10000).optional(),
      audience: z.enum(["Everyone", "Followers", "Friends"]).default("Everyone"),
      comments_enabled: z.boolean().default(true),
      like_count_visible: z.boolean().default(true)
    });

    const data = schema.parse(req.body);

    if (!data.text) {
      return res.status(422).json({
        success: false,
        error: "POST_CONTENT_REQUIRED"
      });
    }

    const result = await query(
      `INSERT INTO posts
       (author_id,text,audience,comments_enabled,like_count_visible)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        req.user.id,
        data.text,
        data.audience,
        data.comments_enabled,
        data.like_count_visible
      ]
    );

    res.status(201).json({
      success: true,
      post: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit || 20), 1),
      50
    );

    const offset = Math.max(Number(req.query.offset || 0), 0);

    const result = await query(
      `SELECT
        p.id,
        p.author_id,
        p.text,
        p.audience,
        p.created_at,
        u.name,
        u.surname,
        u.username,
        u.profile_photo_url
       FROM posts p
       JOIN users u ON u.id=p.author_id
       WHERE p.deleted_at IS NULL
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      success: true,
      posts: result.rows,
      pagination: {
        limit,
        offset,
        returned: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:postId", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.*,u.name,u.surname,u.username,u.profile_photo_url
       FROM posts p
       JOIN users u ON u.id=p.author_id
       WHERE p.id=$1 AND p.deleted_at IS NULL`,
      [req.params.postId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "POST_NOT_FOUND"
      });
    }

    res.json({
      success: true,
      post: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:postId", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE posts
       SET deleted_at=NOW()
       WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.postId, req.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "POST_NOT_FOUND_OR_NOT_OWNER"
      });
    }

    res.json({
      success: true,
      deleted: true
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
JSEOF

cat > src/routes/notifications.js <<'JSEOF'
const express = require("express");
const { authenticate } = require("../middleware/auth");
const { query } = require("../db");

const router = express.Router();

router.get("/", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT *
       FROM notifications
       WHERE recipient_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/read", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE notifications
       SET read_at=NOW()
       WHERE id=$1 AND recipient_id=$2
       RETURNING id,read_at`,
      [req.params.id, req.user.id]
    );

    res.json({
      success: true,
      notification: result.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
JSEOF

cat > src/routes/media.js <<'JSEOF'
const express = require("express");
const crypto = require("crypto");

const { authenticate } = require("../middleware/auth");
const { createUploadUrl } = require("../providers/b2");

const router = express.Router();

router.post("/upload-url", authenticate, async (req, res, next) => {
  try {
    const contentType = String(req.body.content_type || "");

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm"
    ];

    if (!allowed.includes(contentType)) {
      return res.status(422).json({
        success: false,
        error: "UNSUPPORTED_MEDIA_TYPE"
      });
    }

    const extension = contentType.split("/")[1];

    const key =
      `users/${req.user.id}/uploads/` +
      `${crypto.randomUUID()}.${extension}`;

    const uploadUrl = await createUploadUrl(key, contentType);

    res.json({
      success: true,
      media: {
        key,
        content_type: contentType,
        upload_url: uploadUrl
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
JSEOF

cat > schema.sql <<'SQLEOF'
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    surname VARCHAR(100) NOT NULL,
    email VARCHAR(320) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    username VARCHAR(30) UNIQUE,
    bio TEXT,
    category VARCHAR(100),
    country VARCHAR(100),
    state VARCHAR(100),
    gender VARCHAR(30),
    profile_photo_url TEXT,
    cover_photo_url TEXT,
    email_verified_at TIMESTAMPTZ,
    phone_verified_at TIMESTAMPTZ,
    two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    biometric_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id),
    CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_following
ON follows(following_id);

CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(sender_id, receiver_id),
    CHECK(sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver
ON friend_requests(receiver_id,status);

CREATE TABLE IF NOT EXISTS friendships (
    user_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_a,user_b),
    CHECK(user_a < user_b)
);

CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    audience VARCHAR(20) NOT NULL DEFAULT 'Everyone',
    comments_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    like_count_visible BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_posts_author
ON posts(author_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_posts_feed
ON posts(created_at DESC)
WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comments_post
ON comments(post_id,created_at);

CREATE TABLE IF NOT EXISTS reactions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reaction VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,post_id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(60) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    target_type VARCHAR(60),
    target_id UUID,
    data JSONB NOT NULL DEFAULT '{}',
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
ON notifications(recipient_id,created_at DESC);

CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
    media_type VARCHAR(30) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    thumbnail_key TEXT,
    processing_status VARCHAR(30) NOT NULL DEFAULT 'pending',
    size_bytes BIGINT,
    width INTEGER,
    height INTEGER,
    duration_seconds NUMERIC,
    ai_status VARCHAR(30) DEFAULT 'pending',
    ai_detection_confidence NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fcm_token TEXT NOT NULL,
    device_type VARCHAR(30),
    device_model VARCHAR(150),
    os_version VARCHAR(100),
    app_version VARCHAR(50),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,fcm_token)
);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT,
    device_type VARCHAR(30),
    device_model VARCHAR(150),
    os_version VARCHAR(100),
    app_version VARCHAR(50),
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(30) NOT NULL DEFAULT 'info',
    ip_address INET,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQLEOF

cat > server.js <<'JSEOF'
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { WebSocketServer } = require("ws");

const config = require("./src/config/env");
const { query, healthCheck } = require("./src/db");
const requestId = require("./src/utils/requestId");

const healthRoutes = require("./src/routes/health");
const authRoutes = require("./src/routes/auth");
const userRoutes = require("./src/routes/users");
const postRoutes = require("./src/routes/posts");
const notificationRoutes = require("./src/routes/notifications");
const mediaRoutes = require("./src/routes/media");

const {
  notFound,
  errorHandler
} = require("./src/middleware/error");

const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(
  cors({
    origin:
      config.corsOrigins === "*"
        ? true
        : config.corsOrigins.split(",").map(x => x.trim()),
    credentials: true
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use(requestId);

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Connecto API",
    version: "v1",
    status: "online"
  });
});

app.use("/api/v1/health", healthRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/posts", postRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/media", mediaRoutes);

app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

const connectedClients = new Map();

wss.on("connection", (socket, request) => {
  const connectionId = `${Date.now()}-${Math.random()}`;

  connectedClients.set(connectionId, {
    socket,
    connectedAt: new Date()
  });

  socket.send(
    JSON.stringify({
      type: "CONNECTED",
      connection_id: connectionId,
      message: "Connected to Connecto realtime server."
    })
  );

  socket.on("message", message => {
    try {
      const data = JSON.parse(message.toString());

      socket.send(
        JSON.stringify({
          type: "ACK",
          received_type: data.type || "UNKNOWN",
          timestamp: new Date().toISOString()
        })
      );
    } catch {
      socket.send(
        JSON.stringify({
          type: "ERROR",
          error: "INVALID_JSON"
        })
      );
    }
  });

  socket.on("close", () => {
    connectedClients.delete(connectionId);
  });
});

async function start() {
  try {
    await healthCheck();

    console.log("[CONNECTO] PostgreSQL connected.");

    server.listen(config.port, "0.0.0.0", () => {
      console.log("========================================");
      console.log("        CONNECTO API V1 ONLINE");
      console.log("========================================");
      console.log(`HTTP: http://127.0.0.1:${config.port}`);
      console.log(`Health: http://127.0.0.1:${config.port}/api/v1/health`);
      console.log(`DB Health: http://127.0.0.1:${config.port}/api/v1/health/db`);
      console.log(`WebSocket: ws://127.0.0.1:${config.port}/ws`);
      console.log("========================================");
    });
  } catch (error) {
    console.error("[CONNECTO] PostgreSQL connection failed.");
    console.error(error.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

start();
JSEOF

node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync("package.json"));
p.main="server.js";
p.scripts={
  start:"node server.js",
  dev:"node --watch server.js"
};
fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");
'

echo ""
echo "========================================"
echo " CONNECTO V1 FILES CREATED SUCCESSFULLY"
echo "========================================"
echo ""
echo "IMPORTANT:"
echo "1. .env contains placeholders."
echo "2. PostgreSQL credentials must be configured."
echo "3. B2 and FCM credentials can be added later."
echo "4. Run the schema before starting the API."
echo ""
