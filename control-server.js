/* ============================================================================
 * CONNECTO — COMPUTING SYSTEM BACKEND
 * File: control-server.js
 * ==========================================================================*/

"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");

const { query, get, run } = require("./src/db");

/* ============================================================================
 * ENCRYPTION FOR PROVIDER CREDENTIALS (AES-256-GCM)
 * ==========================================================================*/

const MASTER_KEY_HEX =
  process.env.CONTROL_ENCRYPTION_KEY ||
  crypto.randomBytes(32).toString("hex");

const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, "hex");

if (MASTER_KEY.length !== 32) {
  throw new Error(
    "CONTROL_ENCRYPTION_KEY must be 32 bytes (64 hex chars). Generate with: openssl rand -hex 32"
  );
}

if (!process.env.CONTROL_ENCRYPTION_KEY) {
  console.warn(
    "[CONTROL] CONTROL_ENCRYPTION_KEY not set. Using random process-local key. Set it in .env before production."
  );
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptJson(b64) {
  const raw = Buffer.from(b64, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

/* ============================================================================
 * HELPERS
 * ==========================================================================*/

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateSessionToken() {
  return crypto.randomBytes(48).toString("hex");
}

function addMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function nowIso() {
  return new Date().toISOString();
}

/* ============================================================================
 * AUDIT LOG
 * ==========================================================================*/

async function audit({
  adminId = null,
  adminEmail = null,
  action,
  targetType = null,
  targetId = null,
  targetLabel = null,
  oldValue = null,
  newValue = null,
  ip = null,
  userAgent = null
}) {
  try {
    await run(
      `INSERT INTO control_audit_log
       (id, admin_id, admin_email, action, target_type, target_id,
        target_label, old_value, new_value, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        uuidv4(),
        adminId,
        adminEmail,
        action,
        targetType,
        targetId,
        targetLabel,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        ip,
        userAgent
      ]
    );
  } catch (err) {
    console.error("[CONTROL AUDIT] failed:", err.message);
  }
}

/* ============================================================================
 * PROVIDER EVENT LOG
 * ==========================================================================*/

async function providerEvent({
  credentialId = null,
  category = null,
  provider = null,
  eventType,
  status = "info",
  message = null,
  metadata = {}
}) {
  try {
    await run(
      `INSERT INTO provider_events
       (id, credential_id, category, provider, event_type, status, message, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuidv4(),
        credentialId,
        category,
        provider,
        eventType,
        status,
        message,
        JSON.stringify(metadata)
      ]
    );
  } catch (err) {
    console.error("[PROVIDER EVENT] failed:", err.message);
  }
}

/* ============================================================================
 * RATE LIMITER (in-memory)
 * ==========================================================================*/

const rateBuckets = new Map();

function rateLimit({ windowMs = 60000, max = 30, keyFn } = {}) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || "unknown");
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    rateBuckets.set(key, bucket);

    if (bucket.count > max) {
      return res.status(429).json({
        success: false,
        error: "RATE_LIMITED",
        retryAfterMs: bucket.resetAt - now
      });
    }

    next();
  };
}

/* ============================================================================
 * CONTROL AUTH MIDDLEWARE
 * ==========================================================================*/

async function controlAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    }

    const token = header.slice(7);
    const tokenHash = hashToken(token);

    const result = await get(
      `SELECT s.id AS session_id, s.admin_id, s.expires_at, s.revoked_at,
              a.email, a.display_name, a.is_active
       FROM control_sessions s
       JOIN control_admins a ON a.id = s.admin_id
       WHERE s.token_hash = $1
       LIMIT 1`,
      [tokenHash]
    );

    if (!result) {
      return res.status(401).json({ success: false, error: "INVALID_SESSION" });
    }

    if (result.revoked_at) {
      return res.status(401).json({ success: false, error: "SESSION_REVOKED" });
    }

    if (new Date(result.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: "SESSION_EXPIRED" });
    }

    if (!result.is_active) {
      return res.status(403).json({ success: false, error: "ADMIN_DISABLED" });
    }

    await run(
      `UPDATE control_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [result.session_id]
    );

    req.admin = {
      id: result.admin_id,
      email: result.email,
      displayName: result.display_name,
      sessionId: result.session_id
    };

    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "INVALID_SESSION" });
  }
}

/* ============================================================================
 * ROUTER
 * ==========================================================================*/

/* ============================================================================
 * NEW SCHEMA - User actions, verification, broadcast, banned words, labels
 * ==========================================================================*/

(async () => {
  try {
    const { run } = require("./src/db");

    await run(`CREATE TABLE IF NOT EXISTS user_blocks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      duration TEXT NOT NULL,
      reason TEXT,
      blocked_by TEXT,
      blocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id)`);

    await run(`CREATE TABLE IF NOT EXISTS user_suspensions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      duration TEXT NOT NULL,
      reason TEXT,
      suspended_by TEXT,
      suspended_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_suspensions_user ON user_suspensions(user_id)`);

    await run(`CREATE TABLE IF NOT EXISTS user_restrictions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restrictions TEXT NOT NULL,
      duration TEXT NOT NULL,
      restricted_by TEXT,
      restricted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_restrictions_user ON user_restrictions(user_id)`);

    await run(`CREATE TABLE IF NOT EXISTS verification_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      real_name TEXT,
      real_surname TEXT,
      age INTEGER,
      notes TEXT,
      domain TEXT,
      domain_method TEXT,
      domain_verified INTEGER NOT NULL DEFAULT 0,
      domain_token TEXT,
      category TEXT,
      social_links TEXT,
      passport_image TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_verification_requests_status ON verification_requests(status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_verification_requests_user ON verification_requests(user_id)`);

    await run(`CREATE TABLE IF NOT EXISTS pending_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_pending_verifications_user ON pending_verifications(user_id)`);

    await run(`CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_by TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS banned_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL UNIQUE,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS warning_labels (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      text TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT 'faded',
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_warning_labels_post ON warning_labels(post_id)`);

    console.log("[CONTROL] new schema ready");
  } catch (e) {
    console.error("[CONTROL] schema init:", e.message);
  }
})();

const router = express.Router();

/* --- SETUP STATUS ---------------------------------------------------------*/

router.get("/setup/status", async (req, res) => {
  try {
    const lock = await get(
      `SELECT setup_done, setup_done_at FROM control_setup_lock WHERE id = 1`
    );
    const adminCount = await get(
      `SELECT COUNT(*) AS c FROM control_admins`
    );

    res.json({
      success: true,
      setupDone: !!lock?.setup_done,
      setupDoneAt: lock?.setup_done_at || null,
      adminCount: Number(adminCount?.c || 0)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* --- FIRST-RUN SETUP ------------------------------------------------------*/

router.post(
  "/setup",
  rateLimit({ windowMs: 60000, max: 5 }),
  async (req, res) => {
    try {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8).max(128),
        displayName: z.string().max(80).optional()
      });

      const data = schema.parse(req.body);

      const lock = await get(
        `SELECT setup_done FROM control_setup_lock WHERE id = 1`
      );

      if (lock?.setup_done) {
        return res.status(403).json({
          success: false,
          error: "SETUP_ALREADY_COMPLETE"
        });
      }

      const existing = await get(
        `SELECT COUNT(*) AS c FROM control_admins`
      );
      if (Number(existing?.c || 0) > 0) {
        await run(
          `UPDATE control_setup_lock SET setup_done=1, setup_done_at=CURRENT_TIMESTAMP WHERE id=1`
        );
        return res.status(403).json({
          success: false,
          error: "SETUP_ALREADY_COMPLETE"
        });
      }

      const adminId = uuidv4();
      const passwordHash = await bcrypt.hash(data.password, 12);

      await run(
        `INSERT INTO control_admins
         (id, email, password_hash, display_name, is_active)
         VALUES ($1,$2,$3,$4,1)`,
        [
          adminId,
          data.email.toLowerCase(),
          passwordHash,
          data.displayName || null
        ]
      );

      await run(
        `UPDATE control_setup_lock
         SET setup_done=1, setup_done_at=CURRENT_TIMESTAMP, setup_done_by=$1
         WHERE id=1`,
        [adminId]
      );

      const token = generateSessionToken();
      const expiresAt = addDays(new Date(), 7).toISOString();

      await run(
        `INSERT INTO control_sessions
         (id, admin_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuidv4(),
          adminId,
          hashToken(token),
          req.ip,
          req.headers["user-agent"] || null,
          expiresAt
        ]
      );

      await audit({
        adminId,
        adminEmail: data.email.toLowerCase(),
        action: "SETUP_COMPLETE",
        targetType: "control_admin",
        targetId: adminId,
        ip: req.ip,
        userAgent: req.headers["user-agent"] || null
      });

      res.status(201).json({
        success: true,
        admin: {
          id: adminId,
          email: data.email.toLowerCase(),
          displayName: data.displayName || null
        },
        token,
        expiresAt
      });
    } catch (err) {
      if (err.name === "ZodError") {
        return res.status(400).json({
          success: false,
          error: "INVALID_INPUT",
          details: err.issues
        });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

/* --- LOGIN ----------------------------------------------------------------*/

router.post(
  "/login",
  rateLimit({ windowMs: 60000, max: 10 }),
  async (req, res) => {
    try {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(1)
      });

      const data = schema.parse(req.body);

      const admin = await get(
        `SELECT * FROM control_admins WHERE lower(email) = lower($1) LIMIT 1`,
        [data.email]
      );

      if (!admin) {
        return res.status(401).json({
          success: false,
          error: "INVALID_CREDENTIALS"
        });
      }

      if (!admin.is_active) {
        return res.status(403).json({
          success: false,
          error: "ADMIN_DISABLED"
        });
      }

      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        return res.status(423).json({
          success: false,
          error: "ACCOUNT_LOCKED",
          lockedUntil: admin.locked_until
        });
      }

      const valid = await bcrypt.compare(data.password, admin.password_hash);

      if (!valid) {
        const failed = Number(admin.failed_login_count || 0) + 1;
        const lock = failed >= 5;
        await run(
          `UPDATE control_admins
           SET failed_login_count=$1,
               locked_until=$2,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$3`,
          [
            failed,
            lock ? addMinutes(new Date(), 15).toISOString() : null,
            admin.id
          ]
        );

        await audit({
          adminId: admin.id,
          adminEmail: admin.email,
          action: "LOGIN_FAILED",
          ip: req.ip,
          userAgent: req.headers["user-agent"] || null
        });

        return res.status(401).json({
          success: false,
          error: "INVALID_CREDENTIALS"
        });
      }

      await run(
        `UPDATE control_admins
         SET failed_login_count=0, locked_until=NULL,
             last_login_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [admin.id]
      );

      const token = generateSessionToken();
      const expiresAt = addDays(new Date(), 7).toISOString();

      await run(
        `INSERT INTO control_sessions
         (id, admin_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuidv4(),
          admin.id,
          hashToken(token),
          req.ip,
          req.headers["user-agent"] || null,
          expiresAt
        ]
      );

      await audit({
        adminId: admin.id,
        adminEmail: admin.email,
        action: "LOGIN_SUCCESS",
        ip: req.ip,
        userAgent: req.headers["user-agent"] || null
      });

      res.json({
        success: true,
        admin: {
          id: admin.id,
          email: admin.email,
          displayName: admin.display_name
        },
        token,
        expiresAt
      });
    } catch (err) {
      if (err.name === "ZodError") {
        return res.status(400).json({
          success: false,
          error: "INVALID_INPUT",
          details: err.issues
        });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

/* --- LOGOUT ---------------------------------------------------------------*/

router.post("/logout", controlAuth, async (req, res) => {
  await run(
    `UPDATE control_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [req.admin.sessionId]
  );

  await audit({
    adminId: req.admin.id,
    adminEmail: req.admin.email,
    action: "LOGOUT",
    ip: req.ip,
    userAgent: req.headers["user-agent"] || null
  });

  res.json({ success: true });
});

/* --- ME -------------------------------------------------------------------*/

router.get("/me", controlAuth, async (req, res) => {
  res.json({
    success: true,
    admin: {
      id: req.admin.id,
      email: req.admin.email,
      displayName: req.admin.displayName
    }
  });
});

/* --- CHANGE PASSWORD ------------------------------------------------------*/

router.post("/change-password", controlAuth, async (req, res) => {
  try {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(128)
    });

    const data = schema.parse(req.body);

    const admin = await get(
      `SELECT password_hash FROM control_admins WHERE id=$1`,
      [req.admin.id]
    );

    const valid = await bcrypt.compare(data.currentPassword, admin.password_hash);

    if (!valid) {
      return res.status(401).json({
        success: false,
        error: "INVALID_CURRENT_PASSWORD"
      });
    }

    const newHash = await bcrypt.hash(data.newPassword, 12);

    await run(
      `UPDATE control_admins
       SET password_hash=$1,
           password_changed_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [newHash, req.admin.id]
    );

    await run(
      `UPDATE control_sessions
       SET revoked_at=CURRENT_TIMESTAMP
       WHERE admin_id=$1 AND id<>$2`,
      [req.admin.id, req.admin.sessionId]
    );

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "PASSWORD_CHANGED",
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
        details: err.issues
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * CREDENTIALS — LIST / ADD / EDIT / DELETE / ACTIVATE / DEACTIVATE / TEST / ROTATE
 * ==========================================================================*/

const CATEGORY_PROVIDERS = {
  database: ["turso", "postgres", "mysql", "sqlite"],
  email: ["brevo", "smtp", "mailgun", "postmark", "sendgrid"],
  storage: ["b2", "imgbb", "s3", "r2", "wasabi", "local"],
  push: ["fcm"]
};

function validateProvider(category, provider) {
  const list = CATEGORY_PROVIDERS[category];
  if (!list) return false;
  return list.includes(provider);
}

/* LIST */
router.get("/credentials", controlAuth, async (req, res) => {
  try {
    const category = req.query.category || null;
    const provider = req.query.provider || null;

    const rows = await query(
      `SELECT id, category, provider, label, priority,
              is_active, is_primary, daily_limit, used_today, used_total,
              last_used_at, last_tested_at, last_test_ok, last_test_message,
              status, cooldown_until, last_error,
              created_at, updated_at
       FROM provider_credentials
       WHERE ($1 IS NULL OR category = $1)
         AND ($2 IS NULL OR provider = $2)
       ORDER BY category ASC, priority ASC, created_at DESC`,
      [category, provider]
    );

    res.json({ success: true, credentials: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* GET ONE */
router.get("/credentials/:id", controlAuth, async (req, res) => {
  try {
    const row = await get(
      `SELECT * FROM provider_credentials WHERE id = $1`,
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    let credentials = null;
    try {
      credentials = decryptJson(row.credentials_enc);
    } catch {
      credentials = { error: "DECRYPT_FAILED" };
    }

    res.json({
      success: true,
      credential: {
        ...row,
        credentials_enc: undefined,
        credentials
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ADD */
router.post("/credentials", controlAuth, async (req, res) => {
  try {
    const schema = z.object({
      category: z.enum(["database", "email", "storage", "push"]),
      provider: z.string().min(1).max(40),
      label: z.string().min(1).max(120),
      credentials: z.record(z.any()),
      priority: z.number().int().min(1).max(999).optional(),
      daily_limit: z.number().int().min(0).optional(),
      is_primary: z.boolean().optional(),
      is_active: z.boolean().optional()
    });

    const data = schema.parse(req.body);

    if (!validateProvider(data.category, data.provider)) {
      return res.status(400).json({
        success: false,
        error: "UNSUPPORTED_PROVIDER",
        allowed: CATEGORY_PROVIDERS[data.category] || []
      });
    }

    const id = uuidv4();
    const enc = encryptJson(data.credentials);

    if (data.is_primary) {
      await run(
        `UPDATE provider_credentials
         SET is_primary = 0
         WHERE category = $1`,
        [data.category]
      );
    }

    await run(
      `INSERT INTO provider_credentials
       (id, category, provider, label, credentials_enc, priority,
        is_active, is_primary, daily_limit, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)`,
      [
        id,
        data.category,
        data.provider,
        data.label,
        enc,
        data.priority ?? 100,
        data.is_active === false ? 0 : 1,
        data.is_primary ? 1 : 0,
        data.daily_limit ?? null,
        req.admin.id
      ]
    );

    await providerEvent({
      credentialId: id,
      category: data.category,
      provider: data.provider,
      eventType: "CREDENTIAL_CREATED",
      status: "info",
      message: `Added by ${req.admin.email}`
    });

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_CREATED",
      targetType: "provider_credential",
      targetId: id,
      targetLabel: data.label,
      newValue: { category: data.category, provider: data.provider },
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.status(201).json({ success: true, id });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
        details: err.issues
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* EDIT */
router.patch("/credentials/:id", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    const schema = z.object({
      label: z.string().min(1).max(120).optional(),
      credentials: z.record(z.any()).optional(),
      priority: z.number().int().min(1).max(999).optional(),
      daily_limit: z.number().int().min(0).nullable().optional(),
      is_active: z.boolean().optional(),
      is_primary: z.boolean().optional()
    });

    const data = schema.parse(req.body);

    const fields = [];
    const values = [];
    let n = 1;

    if (data.label !== undefined) {
      fields.push(`label=$${n++}`);
      values.push(data.label);
    }

    if (data.priority !== undefined) {
      fields.push(`priority=$${n++}`);
      values.push(data.priority);
    }

    if (data.daily_limit !== undefined) {
      fields.push(`daily_limit=$${n++}`);
      values.push(data.daily_limit);
    }

    if (data.is_active !== undefined) {
      fields.push(`is_active=$${n++}`);
      values.push(data.is_active ? 1 : 0);
    }

    if (data.credentials !== undefined) {
      fields.push(`credentials_enc=$${n++}`);
      values.push(encryptJson(data.credentials));
    }

    if (data.is_primary === true) {
      await run(
        `UPDATE provider_credentials SET is_primary=0 WHERE category=$1`,
        [existing.category]
      );
      fields.push(`is_primary=$${n++}`);
      values.push(1);
    } else if (data.is_primary === false) {
      fields.push(`is_primary=$${n++}`);
      values.push(0);
    }

    if (!fields.length) {
      return res.status(400).json({ success: false, error: "NO_FIELDS" });
    }

    fields.push(`updated_at=CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    await run(
      `UPDATE provider_credentials
       SET ${fields.join(", ")}
       WHERE id=$${n}`,
      values
    );

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_UPDATED",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      oldValue: {
        label: existing.label,
        priority: existing.priority,
        is_active: existing.is_active,
        is_primary: existing.is_primary,
        daily_limit: existing.daily_limit
      },
      newValue: data,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
        details: err.issues
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* DELETE */
router.delete("/credentials/:id", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    await run(
      `DELETE FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_DELETED",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      oldValue: {
        category: existing.category,
        provider: existing.provider,
        label: existing.label
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ACTIVATE */
router.post("/credentials/:id/activate", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    await run(
      `UPDATE provider_credentials
       SET is_active=1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [req.params.id]
    );

    await providerEvent({
      credentialId: req.params.id,
      category: existing.category,
      provider: existing.provider,
      eventType: "CREDENTIAL_ACTIVATED",
      status: "info"
    });

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_ACTIVATED",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* DEACTIVATE */
router.post("/credentials/:id/deactivate", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    await run(
      `UPDATE provider_credentials
       SET is_active=0, is_primary=0, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [req.params.id]
    );

    await providerEvent({
      credentialId: req.params.id,
      category: existing.category,
      provider: existing.provider,
      eventType: "CREDENTIAL_DEACTIVATED",
      status: "info"
    });

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_DEACTIVATED",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* SET PRIMARY */
router.post("/credentials/:id/set-primary", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    await run(
      `UPDATE provider_credentials
       SET is_primary=0
       WHERE category=$1`,
      [existing.category]
    );

    await run(
      `UPDATE provider_credentials
       SET is_primary=1, is_active=1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [req.params.id]
    );

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_SET_PRIMARY",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ROTATE (replace credentials of an existing entry) */
router.post("/credentials/:id/rotate", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    const schema = z.object({
      credentials: z.record(z.any())
    });

    const data = schema.parse(req.body);

    await run(
      `UPDATE provider_credentials
       SET credentials_enc=$1,
           status='ready',
           cooldown_until=NULL,
           last_error=NULL,
           last_test_ok=NULL,
           last_test_message=NULL,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [encryptJson(data.credentials), req.params.id]
    );

    await providerEvent({
      credentialId: req.params.id,
      category: existing.category,
      provider: existing.provider,
      eventType: "CREDENTIAL_ROTATED",
      status: "info"
    });

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_ROTATED",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
        details: err.issues
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* TEST — calls the provider's real endpoint */
router.post("/credentials/:id/test", controlAuth, async (req, res) => {
  try {
    const existing = await get(
      `SELECT * FROM provider_credentials WHERE id=$1`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    let credentials;
    try {
      credentials = decryptJson(existing.credentials_enc);
    } catch {
      return res.status(500).json({
        success: false,
        error: "DECRYPT_FAILED"
      });
    }

    const result = await testProvider(
      existing.category,
      existing.provider,
      credentials
    );

    await run(
      `UPDATE provider_credentials
       SET last_tested_at=CURRENT_TIMESTAMP,
           last_test_ok=$1,
           last_test_message=$2,
           status=$3,
           last_error=$4,
           cooldown_until=$5,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$6`,
      [
        result.ok ? 1 : 0,
        result.message,
        result.ok ? "ready" : "error",
        result.ok ? null : result.message,
        result.ok ? null : addMinutes(new Date(), 5).toISOString(),
        req.params.id
      ]
    );

    await providerEvent({
      credentialId: req.params.id,
      category: existing.category,
      provider: existing.provider,
      eventType: "CREDENTIAL_TESTED",
      status: result.ok ? "ok" : "fail",
      message: result.message,
      metadata: result.metadata || {}
    });

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "CREDENTIAL_TESTED",
      targetType: "provider_credential",
      targetId: req.params.id,
      targetLabel: existing.label,
      newValue: { ok: result.ok, message: result.message },
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({
      success: true,
      ok: result.ok,
      message: result.message,
      metadata: result.metadata || {}
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * PROVIDER TEST IMPLEMENTATIONS
 * ==========================================================================*/

async function testProvider(category, provider, credentials) {
  try {
    if (category === "email" && provider === "brevo") {
      const key = credentials.apiKey || credentials.api_key;
      if (!key) return { ok: false, message: "Missing apiKey" };

      const resp = await fetch("https://api.brevo.com/v3/account", {
        headers: { "api-key": key, accept: "application/json" }
      });

      if (!resp.ok) {
        const body = await resp.text();
        return {
          ok: false,
          message: `Brevo HTTP ${resp.status}: ${body.slice(0, 200)}`
        };
      }

      const data = await resp.json();
      return {
        ok: true,
        message: "Brevo key valid",
        metadata: { email: data.email, plan: data.plan }
      };
    }

    if (category === "storage" && provider === "imgbb") {
      const key = credentials.apiKey || credentials.api_key;
      if (!key) return { ok: false, message: "Missing apiKey" };

      const form = new FormData();
      form.append("image", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
      form.append("key", key);

      const resp = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: form
      });

      const data = await resp.json();

      if (!data.success) {
        return {
          ok: false,
          message: `ImgBB error: ${data.error?.message || "unknown"}`
        };
      }

      return {
        ok: true,
        message: "ImgBB key valid",
        metadata: { url: data.data?.url }
      };
    }

    if (category === "storage" && provider === "b2") {
      const needed = ["endpoint", "region", "bucket", "keyId", "applicationKey"];
      const missing = needed.filter(k => !credentials[k]);
      if (missing.length) {
        return { ok: false, message: `Missing: ${missing.join(", ")}` };
      }
      return { ok: true, message: "B2 credentials present (connection tested on first use)" };
    }

    if (category === "push" && provider === "fcm") {
      const needed = ["projectId", "clientEmail", "privateKey"];
      const missing = needed.filter(k => !credentials[k]);
      if (missing.length) {
        return { ok: false, message: `Missing: ${missing.join(", ")}` };
      }
      return { ok: true, message: "FCM service account present" };
    }

    if (category === "database" && provider === "turso") {
      const needed = ["databaseUrl", "authToken"];
      const missing = needed.filter(k => !credentials[k]);
      if (missing.length) {
        return { ok: false, message: `Missing: ${missing.join(", ")}` };
      }
      return { ok: true, message: "Turso credentials present" };
    }

    return { ok: true, message: "No test implemented for this provider" };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
/* ============================================================================
 * STATE / MONITOR
 * ==========================================================================*/

router.get("/state", controlAuth, async (req, res) => {
  try {
    const [users, posts, comments, follows, calls, queue, admins, sessions, events, creds] =
      await Promise.all([
        get(`SELECT COUNT(*) AS c FROM users`),
        get(`SELECT COUNT(*) AS c FROM posts WHERE deleted_at IS NULL`),
        get(`SELECT COUNT(*) AS c FROM comments WHERE deleted_at IS NULL`),
        get(`SELECT COUNT(*) AS c FROM follows`),
        get(`SELECT COUNT(*) AS c FROM calls`),
        get(`SELECT COUNT(*) AS c FROM email_verification_queue WHERE status='pending'`),
        get(`SELECT COUNT(*) AS c FROM control_admins`),
        get(`SELECT COUNT(*) AS c FROM control_sessions WHERE revoked_at IS NULL`),
        get(`SELECT COUNT(*) AS c FROM provider_events WHERE created_at > datetime('now','-1 day')`),
        get(`SELECT COUNT(*) AS c FROM provider_credentials WHERE is_active=1`)
      ]);

    const wsCount = global.__wsClients ? global.__wsClients.size : 0;

    res.json({
      success: true,
      state: {
        users: Number(users?.c || 0),
        posts: Number(posts?.c || 0),
        comments: Number(comments?.c || 0),
        follows: Number(follows?.c || 0),
        calls: Number(calls?.c || 0),
        pendingEmailQueue: Number(queue?.c || 0),
        controlAdmins: Number(admins?.c || 0),
        activeControlSessions: Number(sessions?.c || 0),
        providerEvents24h: Number(events?.c || 0),
        activeCredentials: Number(creds?.c || 0),
        activeWebSockets: wsCount,
        uptimeSeconds: Math.floor(process.uptime()),
        serverTime: nowIso()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * AUDIT LOG
 * ==========================================================================*/

router.get("/audit-log", controlAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const rows = await query(
      `SELECT * FROM control_audit_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ success: true, entries: rows.rows, limit, offset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * PROVIDER EVENTS
 * ==========================================================================*/

router.get("/provider-events", controlAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const rows = await query(
      `SELECT * FROM provider_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, events: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * WEBHOOKS
 * ==========================================================================*/

router.get("/webhooks", controlAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM webhook_events
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ success: true, webhooks: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/webhooks/:id/retry", controlAuth, async (req, res) => {
  try {
    await run(
      `UPDATE webhook_events
       SET status='pending', next_retry_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [req.params.id]
    );
    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "WEBHOOK_RETRY",
      targetType: "webhook_event",
      targetId: req.params.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * EMAIL QUEUE
 * ==========================================================================*/

router.get("/email/queue", controlAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM email_verification_queue
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ success: true, queue: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/email/queue/:id/retry", controlAuth, async (req, res) => {
  try {
    await run(
      `UPDATE email_verification_queue
       SET status='pending', scheduled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [req.params.id]
    );
    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "EMAIL_QUEUE_RETRY",
      targetType: "email_verification_queue",
      targetId: req.params.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * FEATURE FLAGS
 * ==========================================================================*/

router.get("/feature-flags", controlAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM feature_flags ORDER BY category ASC, key ASC`
    );
    res.json({ success: true, flags: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch("/feature-flags/:key", controlAuth, async (req, res) => {
  try {
    const schema = z.object({ value: z.string().min(1).max(200) });
    const data = schema.parse(req.body);

    const existing = await get(
      `SELECT * FROM feature_flags WHERE key=$1`,
      [req.params.key]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: "NOT_FOUND" });
    }

    await run(
      `UPDATE feature_flags
       SET value=$1, updated_by=$2, updated_at=CURRENT_TIMESTAMP
       WHERE key=$3`,
      [data.value, req.admin.id, req.params.key]
    );

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "FEATURE_FLAG_UPDATED",
      targetType: "feature_flag",
      targetId: req.params.key,
      oldValue: { value: existing.value },
      newValue: { value: data.value },
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
        details: err.issues
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * CHANGE OWN EMAIL
 * ==========================================================================*/

router.post("/change-email", controlAuth, async (req, res) => {
  try {
    const schema = z.object({
      newEmail: z.string().email(),
      password: z.string().min(1)
    });

    const data = schema.parse(req.body);

    const admin = await get(
      `SELECT password_hash FROM control_admins WHERE id=$1`,
      [req.admin.id]
    );

    const valid = await bcrypt.compare(data.password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        error: "INVALID_PASSWORD"
      });
    }

    const taken = await get(
      `SELECT id FROM control_admins WHERE lower(email)=lower($1) AND id<>$2`,
      [data.newEmail, req.admin.id]
    );

    if (taken) {
      return res.status(409).json({
        success: false,
        error: "EMAIL_TAKEN"
      });
    }

    await run(
      `UPDATE control_admins
       SET email=$1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [data.newEmail.toLowerCase(), req.admin.id]
    );

    await audit({
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: "EMAIL_CHANGED",
      oldValue: { email: req.admin.email },
      newValue: { email: data.newEmail.toLowerCase() },
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null
    });

    res.json({ success: true });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
        details: err.issues
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * EXPORT
 * ==========================================================================*/

router.post("/credentials/:id/test-push", controlAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const deviceToken = body.deviceToken;
    const title = body.title;
    const messageBody = body.body;
    if (!deviceToken) {
      return res.status(400).json({ success: false, error: "deviceToken required" });
    }
    const existing = await get(
      "SELECT * FROM provider_credentials WHERE id=$1",
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    let credentials;
    try { credentials = decryptJson(existing.credentials_enc); }
    catch (e) { return res.status(500).json({ success: false, error: "DECRYPT_FAILED" }); }
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: credentials.projectId,
          clientEmail: credentials.clientEmail,
          privateKey: String(credentials.privateKey).replace(/\\n/g, "\n")
        })
      });
    }
    const messageId = await admin.messaging().send({
      token: deviceToken,
      notification: {
        title: title || "Connecto test",
        body: messageBody || "Test push from control panel."
      },
      data: { type: "TEST_PUSH" },
      android: { priority: "high" }
    });
    await providerEvent({
      credentialId: existing.id,
      category: "push",
      provider: "fcm",
      eventType: "FCM_TEST_PUSH",
      status: "ok",
      message: "Test push sent",
      metadata: { messageId: messageId }
    });
    res.json({ success: true, message: "Test push sent", messageId: messageId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.post("/credentials/:id/test-email", controlAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const to = body.to;
    if (!to || !String(to).includes("@")) {
      return res.status(400).json({ success: false, error: "Invalid recipient email" });
    }
    const existing = await get(
      "SELECT * FROM provider_credentials WHERE id=$1",
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    let credentials;
    try { credentials = decryptJson(existing.credentials_enc); }
    catch (e) { return res.status(500).json({ success: false, error: "DECRYPT_FAILED" }); }
    if (existing.provider !== "brevo") {
      return res.status(400).json({ success: false, error: "NOT_BREVO" });
    }
    const apiKey = credentials.apiKey || credentials.api_key;
    if (!apiKey) return res.status(400).json({ success: false, error: "MISSING_API_KEY" });
    const senderEmail = credentials.senderEmail || credentials.sender_email || "no-reply@connecto.app";
    const senderName = credentials.senderName || "Connecto";
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to }],
        subject: "Connecto - Brevo test email",
        htmlContent: "<div style='font-family:sans-serif;padding:20px'><h2>Brevo test successful</h2><p>Sent at " + new Date().toISOString() + "</p><p>Credential: <b>" + existing.label + "</b></p></div>"
      })
    });
    const respBody = await resp.text();
    await providerEvent({
      credentialId: existing.id,
      category: "email",
      provider: "brevo",
      eventType: "BREVO_TEST_EMAIL",
      status: resp.ok ? "ok" : "fail",
      message: resp.ok ? "Test email sent to " + to : "Brevo HTTP " + resp.status,
      metadata: { to: to, response: respBody.slice(0, 500) }
    });
    if (!resp.ok) {
      return res.status(resp.status).json({
        success: false,
        error: "BREVO_SEND_FAILED",
        status: resp.status,
        details: respBody
      });
    }
    res.json({ success: true, message: "Test email sent to " + to });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ============================================================
   PATCH F — CONTROL PANEL BACKEND
   Organizations, verification, display numbers, feature flags
   ==========================================================*/

/* ---------- ORGANIZATIONS (CONTROL API) ---------- */

router.get("/organizations", controlAuth, async (req, res) => {
  try {
    const { query } = require("./src/db");
    const r = await query("SELECT * FROM organizations ORDER BY created_at DESC LIMIT 200");
    res.json({ success: true, organizations: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/organizations", controlAuth, async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const name = String(req.body.name || "").trim();
    const slug = String(req.body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 60);
    const label = String(req.body.label || "Verify Connecto Organization").trim();
    const description = String(req.body.description || "").trim();
    const category = String(req.body.category || "").trim();
    const baseFollowers = Number(req.body.base_follower_count || 1000);
    const dailyLimit = Number(req.body.daily_post_limit || 10);
    const weeklyLimit = Number(req.body.weekly_post_limit || 50);
    const monthlyLimit = Number(req.body.monthly_post_limit || 200);

    if (!name || !slug) return res.status(400).json({ success: false, error: "NAME_AND_SLUG_REQUIRED" });

    const existing = await query("SELECT id FROM organizations WHERE lower(slug)=lower($1) OR lower(name)=lower($2) LIMIT 1", [slug, name]);
    if (existing.rows.length) return res.status(409).json({ success: false, error: "ALREADY_EXISTS" });

    const id = uuidv4();
    await run(
      "INSERT INTO organizations (id, name, slug, label, description, category, owner_id, base_follower_count, daily_post_limit, weekly_post_limit, monthly_post_limit, blue_check) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)",
      [id, name, slug, label, description, category, req.admin.id, baseFollowers, dailyLimit, weeklyLimit, monthlyLimit]
    );

    await run(
      "INSERT INTO organization_members (id, organization_id, user_id, role, status, invited_by, joined_at) VALUES ($1,$2,$3,'admin','active',$4,CURRENT_TIMESTAMP)",
      [uuidv4(), id, req.admin.id, req.admin.id]
    );

    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "ORG_CREATED", targetType: "organization", targetId: id, targetLabel: name, ip: req.ip, userAgent: req.headers["user-agent"] || null });

    res.status(201).json({ success: true, id, name, slug });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch("/organizations/:id", controlAuth, async (req, res) => {
  try {
    const { run } = require("./src/db");
    const allowed = ["name", "label", "description", "category", "logo_url", "cover_url", "base_follower_count", "daily_post_limit", "weekly_post_limit", "monthly_post_limit", "blue_check", "is_active"];
    const fields = [];
    const values = [];
    let n = 1;
    for (const k of allowed) {
      if (req.body[k] !== undefined) { fields.push(k + "=$" + n++); values.push(req.body[k]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: "NO_FIELDS" });
    values.push(req.params.id);
    await run("UPDATE organizations SET " + fields.join(", ") + ", updated_at=CURRENT_TIMESTAMP WHERE id=$" + n, values);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "ORG_UPDATED", targetType: "organization", targetId: req.params.id, newValue: req.body, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/organizations/:id", controlAuth, async (req, res) => {
  try {
    const { run } = require("./src/db");
    await run("UPDATE organizations SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "ORG_DEACTIVATED", targetType: "organization", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/organizations/:id/members", controlAuth, async (req, res) => {
  try {
    const { query } = require("./src/db");
    const r = await query(
      "SELECT om.id, om.role, om.status, om.invited_at, om.joined_at, u.id AS user_id, u.username, u.first_name, u.surname FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id=$1 ORDER BY om.invited_at DESC",
      [req.params.id]
    );
    res.json({ success: true, members: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/organizations/:id/invite", controlAuth, async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const username = String(req.body.username || "").trim();
    const role = String(req.body.role || "contributor").trim();
    if (!username) return res.status(400).json({ success: false, error: "USERNAME_REQUIRED" });
    if (!["admin","editor","contributor"].includes(role)) return res.status(400).json({ success: false, error: "INVALID_ROLE" });

    const target = await query("SELECT id FROM users WHERE lower(username)=lower($1) LIMIT 1", [username]);
    if (!target.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });

    const org = await query("SELECT name FROM organizations WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!org.rows.length) return res.status(404).json({ success: false, error: "ORG_NOT_FOUND" });

    const existing = await query("SELECT * FROM organization_members WHERE organization_id=$1 AND user_id=$2 LIMIT 1", [req.params.id, target.rows[0].id]);
    if (existing.rows.length && existing.rows[0].status === "active") return res.status(409).json({ success: false, error: "ALREADY_MEMBER" });

    if (existing.rows.length) {
      await run("UPDATE organization_members SET role=$1, status='invited', invited_by=$2, invited_at=CURRENT_TIMESTAMP WHERE id=$3", [role, req.admin.id, existing.rows[0].id]);
    } else {
      await run("INSERT INTO organization_members (id, organization_id, user_id, role, status, invited_by) VALUES ($1,$2,$3,$4,'invited',$5)", [uuidv4(), req.params.id, target.rows[0].id, role, req.admin.id]);
    }

    try {
      const { notify } = require("./src/services/notifications");
      if (notify) {
        await notify({
          userId: target.rows[0].id,
          actorId: req.admin.id,
          type: "ORG_INVITE",
          title: "Organization invite",
          body: "You have been invited to join " + org.rows[0].name,
          targetType: "organization",
          targetId: req.params.id
        });
      }
    } catch (e) {}

    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "ORG_INVITED", targetType: "organization", targetId: req.params.id, targetLabel: org.rows[0].name, newValue: { username, role }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, invited: true, user_id: target.rows[0].id, role });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/organizations/:id/members/:userId", controlAuth, async (req, res) => {
  try {
    const { run } = require("./src/db");
    await run("DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2", [req.params.id, req.params.userId]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "ORG_MEMBER_REMOVED", targetType: "organization", targetId: req.params.id, newValue: { userId: req.params.userId }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/organizations/seed", controlAuth, async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const DEFAULT_ORGS = [
      { name: "Connecto News", category: "news" }, { name: "Connecto Football", category: "sports" },
      { name: "Connecto Sports", category: "sports" }, { name: "Connecto Music", category: "music" },
      { name: "Connecto Movies", category: "movies" }, { name: "Connecto TV", category: "entertainment" },
      { name: "Connecto Tech", category: "tech" }, { name: "Connecto Business", category: "business" },
      { name: "Connecto Politics", category: "news" }, { name: "Connecto Health", category: "health" },
      { name: "Connecto Fashion", category: "lifestyle" }, { name: "Connecto Food", category: "lifestyle" },
      { name: "Connecto Travel", category: "lifestyle" }, { name: "Connecto Education", category: "education" },
      { name: "Connecto Jobs", category: "careers" }, { name: "Connecto Gaming", category: "gaming" },
      { name: "Connecto Comedy", category: "entertainment" }, { name: "Connecto Gospel", category: "religion" },
      { name: "Connecto Africa", category: "regional" }, { name: "Connecto Nigeria", category: "regional" }
    ];
    let created = 0, skipped = 0;
    for (const org of DEFAULT_ORGS) {
      const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const existing = await query("SELECT id FROM organizations WHERE lower(slug)=lower($1) LIMIT 1", [slug]);
      if (existing.rows.length) { skipped++; continue; }
      const id = uuidv4();
      await run("INSERT INTO organizations (id, name, slug, label, category, owner_id, base_follower_count, daily_post_limit, weekly_post_limit, monthly_post_limit, blue_check) VALUES ($1,$2,$3,'Verify Connecto Organization',$4,$5,1000,10,50,200,1)", [id, org.name, slug, org.category, req.admin.id]);
      await run("INSERT INTO organization_members (id, organization_id, user_id, role, status, invited_by, joined_at) VALUES ($1,$2,$3,'admin','active',$4,CURRENT_TIMESTAMP)", [uuidv4(), id, req.admin.id, req.admin.id]);
      created++;
    }
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "ORG_SEEDED", newValue: { created, skipped }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, created, skipped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- VERIFY / UNVERIFY USER ---------- */

router.post("/users/:id/verify", controlAuth, async (req, res) => {
  try {
    const { run } = require("./src/db");
    const label = String(req.body.label || "Verified Account");
    await run("UPDATE users SET is_verified=1, verified_label=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [label, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_VERIFIED", targetType: "user", targetId: req.params.id, newValue: { label }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/users/:id/verify", controlAuth, async (req, res) => {
  try {
    const { run } = require("./src/db");
    await run("UPDATE users SET is_verified=0, verified_label=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_UNVERIFIED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- DISPLAY NUMBERS (fake followers / likes) ---------- */

router.post("/users/:id/display-numbers", controlAuth, async (req, res) => {
  try {
    const { run } = require("./src/db");
    const f = req.body.followers;
    const fg = req.body.following;
    const l = req.body.likes;
    await run(
      "UPDATE users SET display_followers=$1, display_following=$2, display_likes=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4",
      [f ?? null, fg ?? null, l ?? null, req.params.id]
    );
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "DISPLAY_NUMBERS_SET", targetType: "user", targetId: req.params.id, newValue: { followers: f, following: fg, likes: l }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- SEARCH USERS (for panel) ---------- */

router.get("/users/search", controlAuth, async (req, res) => {
  try {
    const { query } = require("./src/db");
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) {
      const r = await query("SELECT id, email, username, first_name, surname, is_verified, is_owner, account_status FROM users ORDER BY created_at DESC LIMIT $1", [limit]);
      return res.json({ success: true, users: r.rows });
    }
    const r = await query(
      "SELECT id, email, username, first_name, surname, is_verified, is_owner, account_status FROM users WHERE lower(email) LIKE lower($1) OR lower(username) LIKE lower($1) LIMIT $2",
      ["%" + q + "%", limit]
    );
    res.json({ success: true, users: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================================
 * NEW ENDPOINTS - Users, Revoke, Verification, Broadcast, Moderation
 * ==========================================================================*/

/* ---------- USER SEARCH ---------- */
router.get("/users/search", controlAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) {
      const r = await query("SELECT id, email, username, first_name, surname, is_verified, is_owner, account_status FROM users ORDER BY created_at DESC LIMIT $1", [limit]);
      return res.json({ success: true, users: r.rows });
    }
    const r = await query(
      "SELECT id, email, username, first_name, surname, is_verified, is_owner, account_status FROM users WHERE lower(email) LIKE lower($1) OR lower(username) LIKE lower($1) LIMIT $2",
      ["%" + q + "%", limit]
    );
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- USER BLOCK ---------- */
router.post("/users/:id/block", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const duration = String(req.body.duration || "forever");
    const reason = String(req.body.reason || "").trim();
    let expiresAt = null;
    const now = Date.now();
    if (duration === "1min") expiresAt = new Date(now + 60000).toISOString();
    else if (duration === "1hour") expiresAt = new Date(now + 3600000).toISOString();
    else if (duration === "24hours") expiresAt = new Date(now + 86400000).toISOString();
    else if (duration === "7days") expiresAt = new Date(now + 604800000).toISOString();
    else if (duration === "30days") expiresAt = new Date(now + 2592000000).toISOString();
    await run("INSERT INTO user_blocks (id, user_id, duration, reason, blocked_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuidv4(), userId, duration, reason, req.admin.id, expiresAt]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_BLOCKED", targetType: "user", targetId: userId, newValue: { duration, reason }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- USER SUSPEND ---------- */
router.post("/users/:id/suspend", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const duration = String(req.body.duration || "30days");
    const reason = String(req.body.reason || "").trim();
    let expiresAt = null;
    const now = Date.now();
    if (duration === "1day") expiresAt = new Date(now + 86400000).toISOString();
    else if (duration === "7days") expiresAt = new Date(now + 604800000).toISOString();
    else if (duration === "30days") expiresAt = new Date(now + 2592000000).toISOString();
    else if (duration === "60days") expiresAt = new Date(now + 5184000000).toISOString();
    else if (duration === "90days") expiresAt = new Date(now + 7776000000).toISOString();
    else if (duration === "180days") expiresAt = new Date(now + 15552000000).toISOString();
    else if (duration === "365days") expiresAt = new Date(now + 31536000000).toISOString();
    await run("INSERT INTO user_suspensions (id, user_id, duration, reason, suspended_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuidv4(), userId, duration, reason, req.admin.id, expiresAt]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_SUSPENDED", targetType: "user", targetId: userId, newValue: { duration, reason }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- USER RESTRICT ---------- */
router.post("/users/:id/restrict", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const restrictions = req.body.restrictions || [];
    const duration = String(req.body.duration || "30days");
    if (!Array.isArray(restrictions) || !restrictions.length) {
      return res.status(400).json({ success: false, error: "At least one restriction required" });
    }
    let expiresAt = null;
    const now = Date.now();
    if (duration === "1day") expiresAt = new Date(now + 86400000).toISOString();
    else if (duration === "7days") expiresAt = new Date(now + 604800000).toISOString();
    else if (duration === "30days") expiresAt = new Date(now + 2592000000).toISOString();
    else if (duration === "90days") expiresAt = new Date(now + 7776000000).toISOString();
    await run("INSERT INTO user_restrictions (id, user_id, restrictions, duration, restricted_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuidv4(), userId, JSON.stringify(restrictions), duration, req.admin.id, expiresAt]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "USER_RESTRICTED", targetType: "user", targetId: userId, newValue: { restrictions, duration }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- SEND VERIFICATION ---------- */
router.post("/users/:id/verify-send", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const userId = req.params.id;
    const message = String(req.body.message || "You have been verified.").trim();
    await run("INSERT INTO pending_verifications (id, user_id, message) VALUES ($1,$2,$3)",
      [uuidv4(), userId, message]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_SENT", targetType: "user", targetId: userId, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- REVOKE ENDPOINTS ---------- */
router.post("/users/:id/revoke-block", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM user_blocks WHERE user_id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BLOCK_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/revoke-suspend", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM user_suspensions WHERE user_id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "SUSPENSION_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/revoke-restrict", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM user_restrictions WHERE user_id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "RESTRICTION_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/revoke-verify", controlAuth, async (req, res) => {
  try {
    await run("UPDATE users SET is_verified=0, verified_label=NULL WHERE id=$1", [req.params.id]);
    await run("DELETE FROM pending_verifications WHERE user_id=$1 AND status='pending'", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_REVOKED", targetType: "user", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- LIST ENDPOINTS FOR REVOKE TAB ---------- */
router.get("/users/blocked", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT u.id, u.email, u.username, u.first_name, u.surname, b.duration, b.reason, b.blocked_at FROM user_blocks b JOIN users u ON u.id = b.user_id ORDER BY b.blocked_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/users/suspended", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT u.id, u.email, u.username, u.first_name, u.surname, s.duration, s.reason, s.suspended_at FROM user_suspensions s JOIN users u ON u.id = s.user_id ORDER BY s.suspended_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/users/restricted", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT u.id, u.email, u.username, u.first_name, u.surname, r.restrictions, r.duration, r.restricted_at FROM user_restrictions r JOIN users u ON u.id = r.user_id ORDER BY r.restricted_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/users/verified", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, email, username, first_name, surname, verified_label FROM users WHERE is_verified=1 ORDER BY updated_at DESC LIMIT 100");
    res.json({ success: true, users: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- FOLLOWERS ADD / REMOVE ---------- */
router.post("/users/:id/followers/add", controlAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });
    const cur = await query("SELECT display_followers FROM users WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    const current = Number(cur.rows[0].display_followers || 0);
    await run("UPDATE users SET display_followers=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [current + amount, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "FOLLOWERS_ADDED", targetType: "user", targetId: req.params.id, newValue: { amount }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, newTotal: current + amount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/users/:id/followers/remove", controlAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });
    const cur = await query("SELECT display_followers FROM users WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    const current = Number(cur.rows[0].display_followers || 0);
    if (current < amount) {
      return res.status(400).json({ success: false, error: "USER_DOES_NOT_HAVE_ENOUGH_FOLLOWERS", current });
    }
    await run("UPDATE users SET display_followers=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [current - amount, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "FOLLOWERS_REMOVED", targetType: "user", targetId: req.params.id, newValue: { amount }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, newTotal: current - amount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- VERIFICATION REQUESTS ---------- */
router.get("/verification-requests", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT * FROM verification_requests ORDER BY created_at DESC LIMIT 100");
    res.json({ success: true, requests: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/verification-requests/:id/approve", controlAuth, async (req, res) => {
  try {
    const vr = await query("SELECT * FROM verification_requests WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!vr.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    const userId = vr.rows[0].user_id;
    const { v4: uuidv4 } = require("uuid");
    await run("UPDATE verification_requests SET status='approved', reviewed_by=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2", [req.admin.id, req.params.id]);
    await run("INSERT INTO pending_verifications (id, user_id, message) VALUES ($1,$2,$3)",
      [uuidv4(), userId, "Your verification has been approved."]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_APPROVED", targetType: "user", targetId: userId, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/verification-requests/:id/decline", controlAuth, async (req, res) => {
  try {
    await run("UPDATE verification_requests SET status='declined', reviewed_by=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2", [req.admin.id, req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "VERIFICATION_DECLINED", targetType: "verification_request", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- BROADCAST ---------- */
router.post("/broadcast", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();
    if (!title || !body) return res.status(400).json({ success: false, error: "TITLE_AND_BODY_REQUIRED" });
    let sentCount = 0, failCount = 0;
    try {
      const tokens = await query("SELECT token FROM device_tokens WHERE active=1");
      const list = tokens.rows.map(t => t.token).filter(Boolean);
      if (list.length) {
        const admin = require("firebase-admin");
        if (admin.apps.length) {
          const r = await admin.messaging().sendEachForMulticast({
            tokens: list,
            notification: { title, body }
          });
          sentCount = r.successCount || 0;
          failCount = r.failureCount || 0;
        }
      }
    } catch (e) { console.error("[BROADCAST-FCM]", e.message); }
    const id = uuidv4();
    await run("INSERT INTO broadcasts (id, title, body, sent_by, sent_count, fail_count) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, title, body, req.admin.id, sentCount, failCount]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BROADCAST_SENT", targetType: "broadcast", targetId: id, newValue: { title, sentCount, failCount }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true, sent: sentCount, failed: failCount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/broadcasts", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50");
    res.json({ success: true, broadcasts: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- CONTENT MODERATION ---------- */
router.get("/content/posts", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100");
    res.json({ success: true, items: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/content/videos", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='video' LIMIT 1) AS media_url FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100");
    res.json({ success: true, items: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get("/content/images", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.type='image' LIMIT 1) AS media_url FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100");
    res.json({ success: true, items: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete("/content/:id", controlAuth, async (req, res) => {
  try {
    await run("UPDATE posts SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "CONTENT_DELETED", targetType: "post", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/content/:id/label", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const text = String(req.body.text || "").trim();
    const style = String(req.body.style || "faded");
    if (!text) return res.status(400).json({ success: false, error: "TEXT_REQUIRED" });
    await run("INSERT INTO warning_labels (id, post_id, text, style, added_by) VALUES ($1,$2,$3,$4,$5)",
      [uuidv4(), req.params.id, text, style, req.admin.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "LABEL_ADDED", targetType: "post", targetId: req.params.id, newValue: { text, style }, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- BANNED WORDS ---------- */
router.get("/banned-words", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT * FROM banned_words ORDER BY created_at DESC LIMIT 500");
    res.json({ success: true, words: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post("/banned-words", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const word = String(req.body.word || "").trim().toLowerCase();
    if (!word) return res.status(400).json({ success: false, error: "WORD_REQUIRED" });
    await run("INSERT INTO banned_words (id, word, added_by) VALUES ($1,$2,$3) ON CONFLICT(word) DO NOTHING",
      [uuidv4(), word, req.admin.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BANNED_WORD_ADDED", targetType: "banned_word", targetId: word, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete("/banned-words/:id", controlAuth, async (req, res) => {
  try {
    await run("DELETE FROM banned_words WHERE id=$1", [req.params.id]);
    await audit({ adminId: req.admin.id, adminEmail: req.admin.email, action: "BANNED_WORD_REMOVED", targetType: "banned_word", targetId: req.params.id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

console.log("[CONTROL] new endpoints ready"); * PHASE A - Verification endpoints, bookmarks
 * ==========================================================================*/

router.get("/me/bookmarks", controlAuth, async (req, res) => {
  try {
    const r = await query(
      "SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, u.is_verified AS author_verified FROM bookmarks b JOIN posts p ON p.id = b.post_id JOIN users u ON u.id = p.author_id WHERE b.user_id=$1 AND p.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 100",
      [req.admin.id]
    );
    res.json({ success: true, posts: r.rows });
  } catch (err) {
    res.json({ success: true, posts: [] });
  }
});

router.post("/verification/start", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const existing = await query("SELECT id FROM verification_requests WHERE user_id=$1 AND status='pending' LIMIT 1", [req.admin.id]);
    if (existing.rows.length) {
      return res.json({ success: true, alreadyPending: true, requestId: existing.rows[0].id });
    }
    const id = uuidv4();
    await run("INSERT INTO verification_requests (id, user_id, status) VALUES ($1,$2,'pending')", [id, req.admin.id]);
    res.json({ success: true, requestId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/verification/verify-domain", controlAuth, async (req, res) => {
  try {
    const domain = String(req.body.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const method = String(req.body.method || "meta");
    const token = String(req.body.token || "").trim();
    if (!domain || !token) {
      return res.status(400).json({ success: false, error: "DOMAIN_AND_TOKEN_REQUIRED" });
    }

    if (method === "meta") {
      try {
        const url = "https://" + domain;
        const resp = await fetch(url, { redirect: "follow", headers: { "User-Agent": "ConnectoVerify/1.0" } });
        const html = await resp.text();
        if (html.includes(token)) {
          await run("UPDATE verification_requests SET domain=$1, domain_method=$2, domain_verified=1, domain_token=$3 WHERE user_id=$4 AND status='pending'", [domain, method, token, req.admin.id]);
          return res.json({ success: true, verified: true });
        }
        return res.json({ success: true, verified: false, reason: "META_TAG_NOT_FOUND" });
      } catch (e) {
        return res.json({ success: true, verified: false, reason: "FETCH_FAILED", details: e.message });
      }
    }

    if (method === "dns") {
      try {
        const dns = require("dns").promises;
        const records = await dns.resolveTxt(domain);
        const flat = records.map(r => r.join("")).join(" ");
        if (flat.includes(token)) {
          await run("UPDATE verification_requests SET domain=$1, domain_method=$2, domain_verified=1, domain_token=$3 WHERE user_id=$4 AND status='pending'", [domain, method, token, req.admin.id]);
          return res.json({ success: true, verified: true });
        }
        return res.json({ success: true, verified: false, reason: "DNS_RECORD_NOT_FOUND" });
      } catch (e) {
        return res.json({ success: true, verified: false, reason: "DNS_LOOKUP_FAILED", details: e.message });
      }
    }

    res.status(400).json({ success: false, error: "INVALID_METHOD" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/verification/submit", controlAuth, async (req, res) => {
  try {
    const realName = String(req.body.realName || "").trim();
    const realSurname = String(req.body.realSurname || "").trim();
    const age = Number(req.body.age) || 0;
    const notes = String(req.body.notes || "").trim();
    const category = String(req.body.category || "").trim();
    const socialLinks = String(req.body.socialLinks || "").trim();

    if (!realName || !realSurname || !age || !socialLinks) {
      return res.status(400).json({ success: false, error: "MISSING_REQUIRED_FIELDS" });
    }
    if (age < 18) {
      return res.status(400).json({ success: false, error: "MUST_BE_18_OR_OLDER" });
    }

    const existing = await query("SELECT id FROM verification_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!existing.rows.length) {
      return res.status(400).json({ success: false, error: "NO_PENDING_REQUEST" });
    }
    const requestId = existing.rows[0].id;

    await run(
      "UPDATE verification_requests SET real_name=$1, real_surname=$2, age=$3, notes=$4, category=$5, social_links=$6, status='pending' WHERE id=$7",
      [realName, realSurname, age, notes, category, socialLinks, requestId]
    );

    res.json({ success: true, requestId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/verification/status", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, status, real_name, real_surname, category, created_at, reviewed_at FROM verification_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!r.rows.length) {
      return res.json({ success: true, status: "none" });
    }
    res.json({ success: true, status: r.rows[0].status, request: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/pending-verification", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, message FROM pending_verifications WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!r.rows.length) {
      return res.json({ success: true, pending: false });
    }
    res.json({ success: true, pending: true, id: r.rows[0].id, message: r.rows[0].message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/pending-verification/:id/accept", controlAuth, async (req, res) => {
  try {
    await run("UPDATE pending_verifications SET status='accepted' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    await run("UPDATE users SET is_verified=1, verified_label='Verified Account', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/pending-verification/:id/decline", controlAuth, async (req, res) => {
  try {
    await run("UPDATE pending_verifications SET status='declined' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

console.log("[PHASE-A] verification endpoints ready");
console.log("[CONTROL-SERVER] loaded " + (router.stack.filter(l=>l.route).length) + " routes");
module.exports = router;
