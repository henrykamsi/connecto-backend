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
module.exports = router;
