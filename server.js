const express = require("express");

function sha256Hex(s) {
  return cryptoA.createHash("sha256").update(String(s)).digest("hex");
}

async function getProviderCredential(category, provider) {
  try {
    const { query } = require("./src/db");
    const r = await query(
      "SELECT * FROM provider_credentials WHERE category=$1 AND provider=$2 AND is_active=1 ORDER BY is_primary DESC, priority ASC LIMIT 1",
      [category, provider]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const KEY = process.env.CONTROL_ENCRYPTION_KEY;
    if (!KEY) return null;
    const raw = Buffer.from(row.credentials_enc, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = cryptoA.createDecipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch (e) {
    console.error("[getProviderCredential]", e.message);
    return null;
  }
}

async function sendBrevoEmail(to, subject, htmlContent) {
  const cred = await getProviderCredential("email", "brevo");
  if (!cred) return { sent: false, reason: "NO_BREVO_CREDENTIAL" };
  const apiKey = cred.apiKey || cred.api_key;
  if (!apiKey) return { sent: false, reason: "NO_API_KEY" };
  const senderEmail = cred.senderEmail || "henryglobaltechs@gmail.com";
  const senderName = cred.senderName || "Henry Global Tech";
  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
      })
    });
    const body = await resp.text();
    if (!resp.ok) return { sent: false, reason: "BREVO_FAILED", status: resp.status, details: body };
    return { sent: true, details: body };
  } catch (e) {
    return { sent: false, reason: "NETWORK_ERROR", details: e.message };
  }
}

const http = require("http");
const cors = require("cors");
const helmet = require("helmet");

const env = require("./src/config/env");
const { query } = require("./src/db");
const { attachRealtime } = require("./src/websocket/realtime");
const v1 = require("./src/routes/complete-v1");
const controlRouter = require("./control-server");

const cryptoA = require("crypto");
function sha256Hex(s){return cryptoA.createHash("sha256").update(String(s)).digest("hex");}
const app = express();
const server = http.createServer(app);

app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
  origin:
    env.corsOrigins === "*"
      ? "*"
      : env.corsOrigins.split(",").map(x => x.trim()),
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "10mb"
}));

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Connecto",
    version: "v1"
  });
});


/* GLOBAL WEBHOOK LOGGER v2 */
const WEBHOOK_EVENT_MAP = {
  "POST /api/v1/auth/register": "user.registered",
  "POST /api/v1/auth/login": "user.logged_in",
  "POST /api/v1/auth/logout": "user.logged_out",
  "POST /api/v1/auth/refresh": "token.refreshed",
  "POST /api/v1/profile/complete": "profile.completed",
  "PATCH /api/v1/profile": "profile.updated",
  "POST /api/v1/posts": "post.created",
  "POST /api/v1/posts/:postId/reactions": "post.reacted",
  "POST /api/v1/posts/:postId/comments": "comment.created",
  "POST /api/v1/social/follow/:userId": "user.followed",
  "DELETE /api/v1/social/follow/:userId": "user.unfollowed",
  "POST /api/v1/social/friend-request/:userId": "friend.requested",
  "POST /api/v1/social/friend-request/:id/accept": "friend.accepted",
  "POST /api/v1/chat/conversations": "chat.created",
  "POST /api/v1/chat/conversations/:id/messages": "message.sent",
  "POST /api/v1/calls": "call.initiated",
  "POST /api/v1/calls/:id/accept": "call.accepted",
  "POST /api/v1/calls/:id/reject": "call.rejected",
  "POST /api/v1/calls/:id/end": "call.ended",
  "POST /api/v1/blocks/:userId": "user.blocked",
  "POST /api/v1/reports": "report.created",
  "POST /api/v1/devices": "device.registered",
  "POST /api/v1/auth/change-password": "password.changed"
};

function matchWebhookEvent(method, path) {
  const keys = Object.keys(WEBHOOK_EVENT_MAP);
  for (let i = 0; i < keys.length; i++) {
    const parts = keys[i].split(" ");
    if (parts[0] !== method) continue;
    const regex = new RegExp("^" + parts[1].replace(/:[^/]+/g, "[^/]+") + "$");
    if (regex.test(path)) return WEBHOOK_EVENT_MAP[keys[i]];
  }
  return null;
}

app.use(function webhookLogger(req, res, next) {
  if (req.path.indexOf("/control-api") === 0) return next();
  if (req.path.indexOf("/ws") === 0) return next();

  const eventName = matchWebhookEvent(req.method, req.path);
  if (!eventName) return next();

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  let logged = false;

  async function logEvent(statusCode) {
    if (logged) return;
    logged = true;
    if (statusCode >= 400) return;

    try {
      const db = require("./src/db");
      const uuid = require("uuid");

      const actorId = req.user && req.user.id ? req.user.id : null;
      const targetId =
        (req.params && req.params.postId) ||
        (req.params && req.params.userId) ||
        (req.params && req.params.id) ||
        null;

      const payload = {
        method: req.method,
        path: req.path,
        actorId: actorId,
        targetId: targetId,
        status: statusCode,
        at: new Date().toISOString()
      };

      await db.run(
        "INSERT INTO webhook_events (id, direction, source, event_type, url, status, attempts, request_body, status_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          uuid.v4(),
          "internal",
          "connecto-api",
          eventName,
          null,
          "logged",
          0,
          JSON.stringify(payload),
          statusCode
        ]
      );

      console.log("[WEBHOOK LOGGED]", eventName);
    } catch (err) {
      console.error("[WEBHOOK LOG FAILED]", err.message);
    }
  }

  res.json = function(body) {
    const status = res.statusCode;
    logEvent(status).finally(function() {
      originalJson(body);
    });
    return res;
  };

  res.send = function(body) {
    const status = res.statusCode;
    logEvent(status).finally(function() {
      originalSend(body);
    });
    return res;
  };

  next();
});
/* ============================================================
   EMAIL VERIFICATION — 6-digit code via Brevo
   ==========================================================*/

const cryptoVerify = require("crypto");

async function getBrevoCredential() {
  const { query } = require("./src/db");
  const r = await query(
    `SELECT * FROM provider_credentials
     WHERE category='email' AND provider='brevo' AND is_active=1
     ORDER BY is_primary DESC, priority ASC
     LIMIT 1`
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];

  const MASTER_KEY_HEX = process.env.CONTROL_ENCRYPTION_KEY;
  if (!MASTER_KEY_HEX) return null;

  const raw = Buffer.from(row.credentials_enc, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = cryptoVerify.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(MASTER_KEY_HEX, "hex"),
    iv
  );
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function buildVerificationEmail(code, firstName) {
  const blue = "#1E90FF";
  const green = "#00FF7F";
  const dark = "#333333";
  const gray = "#888888";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Verify your Connecto account</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:20px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

        <tr>
          <td align="center" style="background:${blue};padding:28px 20px;">
            <div style="color:${green};font-size:26px;font-weight:bold;letter-spacing:3px;">CONNECTO</div>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 20px 40px;color:${dark};font-size:15px;line-height:1.6;">
            <p style="margin:0 0 10px 0;">Hi ${firstName || "there"},</p>
            <p style="margin:0;">Use the code below to verify your Connecto account.</p>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:10px 40px 20px 40px;">
            <table cellpadding="0" cellspacing="0" style="background:${blue};border-radius:10px;padding:0;">
              <tr>
                <td align="center" style="padding:24px 40px;">
                  <div style="color:${green};font-size:38px;font-weight:bold;letter-spacing:10px;font-family:Consolas,monospace;">${code}</div>
                </td>
              </tr>
            </table>

            <p style="margin:16px 0 0 0;color:${gray};font-size:13px;">
              Tap and hold to copy the code, then paste it in the app.
            </p>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:0 40px 24px 40px;">
            <div style="color:${dark};font-size:14px;">
              This code expires in <b>10 minutes</b>.
            </div>
            <div style="margin-top:8px;color:${gray};font-size:13px;">
              You can request a new code up to 2 times per hour.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 32px 40px;color:${gray};font-size:13px;line-height:1.6;">
            If you did not request this code, you can safely ignore this email.
          </td>
        </tr>

        <tr>
          <td align="center" style="background:#f4f6f8;padding:20px;color:${gray};font-size:12px;line-height:1.6;">
            Powered by Henry Global Tech<br>
            All rights reserved. Henry Global Tech Industry (HGT) &copy; 2026
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendVerificationEmail(email, code, firstName) {
  const cred = await getBrevoCredential();
  if (!cred) return { sent: false, reason: "NO_BREVO_CREDENTIAL" };

  const apiKey = cred.apiKey || cred.api_key;
  if (!apiKey) return { sent: false, reason: "NO_API_KEY" };

  const senderEmail = cred.senderEmail || "henryglobaltechs@gmail.com";
  const senderName = cred.senderName || "Henry Global Tech";

  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: email }],
      subject: "Your Connecto verification code",
      htmlContent: buildVerificationEmail(code, firstName)
    })
  });

  const body = await resp.text();
  if (!resp.ok) {
    console.error("[BREVO VERIFY SEND FAILED]", resp.status, body);
    return { sent: false, reason: "BREVO_FAILED", status: resp.status, details: body };
  }
  return { sent: true, details: body };
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* POST /api/v1/auth/send-verification */
app.post("/api/v1/auth/send-verification", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    let userId = null;
    let email = req.body.email;
    let firstName = null;

    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7), envLocal.jwt.secret);
        userId = payload.sub;
      } catch (e) {}
    }

    if (!userId && email) {
      const found = await query(`SELECT id, first_name FROM users WHERE lower(email)=lower($1) LIMIT 1`, [email]);
      if (found.rows.length) {
        userId = found.rows[0].id;
        firstName = found.rows[0].first_name;
      }
    }

    if (userId && !firstName) {
      const u = await query(`SELECT first_name, email FROM users WHERE id=$1 LIMIT 1`, [userId]);
      if (u.rows.length) {
        firstName = u.rows[0].first_name;
        email = u.rows[0].email;
      }
    }

    if (!userId || !email) {
      return res.status(400).json({ success: false, error: "USER_NOT_FOUND" });
    }

    const recent = await query(
      `SELECT COUNT(*) AS c FROM verification_codes
       WHERE user_id=$1 AND purpose='email_verify'
         AND created_at > datetime('now','-1 hour')`,
      [userId]
    );

    const sentLastHour = Number(recent.rows[0].c || 0);
    if (sentLastHour >= 2) {
      return res.status(429).json({
        success: false,
        error: "RESEND_LIMIT_REACHED",
        message: "You can only request 2 codes per hour. Please wait."
      });
    }

    const code = generateSixDigitCode();
    const codeHash = cryptoVerify.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await run(
      `INSERT INTO verification_codes (id, user_id, channel, destination, code_hash, purpose, expires_at)
       VALUES ($1,$2,'email',$3,$4,'email_verify',$5)`,
      [uuidv4(), userId, email, codeHash, expiresAt]
    );

    const sendResult = await sendVerificationEmail(email, code, firstName);

    if (!sendResult.sent) {
      return res.status(502).json({
        success: false,
        error: "EMAIL_SEND_FAILED",
        details: sendResult
      });
    }

    res.json({ success: true, message: "Verification code sent to " + email });
  } catch (err) {
    console.error("[SEND VERIFICATION ERROR]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* POST /api/v1/auth/verify-email */
app.post("/api/v1/auth/verify-email", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { code, email } = req.body;

    if (!code || !email) {
      return res.status(400).json({ success: false, error: "CODE_AND_EMAIL_REQUIRED" });
    }

    const codeHash = cryptoVerify.createHash("sha256").update(String(code)).digest("hex");

    const r = await query(
      `SELECT vc.*, u.id AS uid FROM verification_codes vc
       JOIN users u ON u.id = vc.user_id
       WHERE lower(vc.destination)=lower($1)
         AND vc.code_hash=$2
         AND vc.purpose='email_verify'
         AND vc.used_at IS NULL
         AND vc.expires_at > CURRENT_TIMESTAMP
       ORDER BY vc.created_at DESC
       LIMIT 1`,
      [email, codeHash]
    );

    if (!r.rows.length) {
      return res.status(400).json({ success: false, error: "INVALID_OR_EXPIRED_CODE" });
    }

    const row = r.rows[0];

    await run(`UPDATE verification_codes SET used_at=CURRENT_TIMESTAMP WHERE id=$1`, [row.id]);
    await run(`UPDATE users SET email_verified=1, updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [row.uid]);

    res.json({ success: true, message: "Email verified successfully" });
  } catch (err) {
    console.error("[VERIFY EMAIL ERROR]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ============================================================
   PATCH A — PART 1
   Forgot password, dismiss-verify-prompt
   Uses existing helpers already in server.js:
     - cryptoA, sha256Hex, getProviderCredential, sendBrevoEmail
   ==========================================================*/

/* ---------- FORGOT PASSWORD ---------- */

app.post("/api/v1/auth/forgot-password", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: "EMAIL_REQUIRED" });

    const found = await query(
      "SELECT id, first_name FROM users WHERE lower(email)=lower($1) LIMIT 1",
      [email]
    );
    if (!found.rows.length) {
      return res.json({ success: true, message: "If the email exists, a reset code was sent." });
    }
    const user = found.rows[0];

    const recent = await query(
      "SELECT COUNT(*) AS c FROM verification_codes WHERE user_id=$1 AND purpose='password_reset' AND created_at > datetime('now','-1 hour')",
      [user.id]
    );
    if (Number(recent.rows[0].c || 0) >= 3) {
      return res.status(429).json({ success: false, error: "RESEND_LIMIT_REACHED" });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = cryptoA.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await run(
      "INSERT INTO verification_codes (id, user_id, channel, destination, code_hash, purpose, expires_at) VALUES ($1,$2,'email',$3,$4,'password_reset',$5)",
      [uuidv4(), user.id, email, codeHash, expiresAt]
    );

    const html = buildVerificationEmail(code, user.first_name);
    const result = await sendBrevoEmail(email, "Reset your Connecto password", html);

    if (!result.sent) {
      return res.status(502).json({ success: false, error: "EMAIL_SEND_FAILED", details: result });
    }

    res.json({ success: true, message: "If the email exists, a reset code was sent." });
  } catch (err) {
    console.error("[FORGOT-PASSWORD]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/auth/reset-password", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const bcrypt = require("bcryptjs");
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "");
    const newPassword = String(req.body.newPassword || "");

    if (!email || !code || !newPassword) return res.status(400).json({ success: false, error: "MISSING_FIELDS" });
    if (newPassword.length < 8) return res.status(400).json({ success: false, error: "PASSWORD_TOO_SHORT" });

    const codeHash = cryptoA.createHash("sha256").update(code).digest("hex");

    const r = await query(
      "SELECT vc.*, u.id AS uid FROM verification_codes vc JOIN users u ON u.id = vc.user_id WHERE lower(vc.destination)=lower($1) AND vc.code_hash=$2 AND vc.purpose='password_reset' AND vc.used_at IS NULL AND vc.expires_at > CURRENT_TIMESTAMP ORDER BY vc.created_at DESC LIMIT 1",
      [email, codeHash]
    );
    if (!r.rows.length) return res.status(400).json({ success: false, error: "INVALID_OR_EXPIRED_CODE" });

    const row = r.rows[0];
    const hash = await bcrypt.hash(newPassword, 12);

    await run("UPDATE users SET password_hash=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [hash, row.uid]);
    await run("UPDATE verification_codes SET used_at=CURRENT_TIMESTAMP WHERE id=$1", [row.id]);
    await run("UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL", [row.uid]);

    res.json({ success: true, message: "Password reset successfully." });
  } catch (err) {
    console.error("[RESET-PASSWORD]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- DISMISS VERIFY PROMPT (count Close taps) ---------- */

app.post("/api/v1/auth/dismiss-verify-prompt", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    }
    let userId = null;
    try {
      const payload = jwt.verify(authHeader.slice(7), envLocal.jwt.secret);
      userId = payload.sub;
    } catch (e) {
      return res.status(401).json({ success: false, error: "INVALID_SESSION" });
    }

    await run(
      "UPDATE users SET verify_prompt_dismissals = COALESCE(verify_prompt_dismissals,0) + 1, updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [userId]
    );

    const u = await query(
      "SELECT verify_prompt_dismissals, verify_grace_started_at, email_verified FROM users WHERE id=$1",
      [userId]
    );
    const row = u.rows[0] || {};

    res.json({
      success: true,
      dismissals: Number(row.verify_prompt_dismissals || 0),
      grace_started_at: row.verify_grace_started_at || null,
      email_verified: Number(row.email_verified || 0)
    });
  } catch (err) {
    console.error("[DISMISS-VERIFY-PROMPT]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ============================================================
   PATCH A — PART 2
   Biometric, Google, account deletion, background retry
   ==========================================================*/

/* ---------- BIOMETRIC ENABLE / DISABLE ---------- */

app.post("/api/v1/auth/biometric/enable", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });

    let userId = null;
    try {
      const payload = jwt.verify(authHeader.slice(7), envLocal.jwt.secret);
      userId = payload.sub;
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const deviceId = String(req.body.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ success: false, error: "DEVICE_ID_REQUIRED" });

    await run(
      "UPDATE users SET biometric_enabled=1, biometric_device_id=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2",
      [deviceId, userId]
    );

    res.json({ success: true, message: "Biometric enabled." });
  } catch (err) {
    console.error("[BIOMETRIC-ENABLE]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/auth/biometric/disable", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });

    let userId = null;
    try {
      const payload = jwt.verify(authHeader.slice(7), envLocal.jwt.secret);
      userId = payload.sub;
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    await run(
      "UPDATE users SET biometric_enabled=0, biometric_device_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [userId]
    );

    res.json({ success: true, message: "Biometric disabled." });
  } catch (err) {
    console.error("[BIOMETRIC-DISABLE]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- GOOGLE LOGIN ---------- */

app.post("/api/v1/auth/google", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const cryptoLocal = require("crypto");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const idToken = String(req.body.idToken || "").trim();
    if (!idToken) return res.status(400).json({ success: false, error: "ID_TOKEN_REQUIRED" });

    const googleCred = await getProviderCredential("auth", "google");
    const clientId = googleCred && googleCred.clientId;
    if (!clientId) return res.status(503).json({ success: false, error: "GOOGLE_NOT_CONFIGURED" });

    const verifyResp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!verifyResp.ok) return res.status(401).json({ success: false, error: "INVALID_GOOGLE_TOKEN" });
    const info = await verifyResp.json();
    if (info.aud !== clientId) return res.status(401).json({ success: false, error: "AUDIENCE_MISMATCH" });

    const email = String(info.email || "").toLowerCase();
    const googleId = String(info.sub || "");
    if (!email || !googleId) return res.status(400).json({ success: false, error: "MISSING_GOOGLE_FIELDS" });

    let userId = null;
    let firstName = null;
    let isNew = false;

    const existing = await query(
      "SELECT id, first_name FROM users WHERE lower(email)=lower($1) OR google_id=$2 LIMIT 1",
      [email, googleId]
    );

    if (existing.rows.length) {
      userId = existing.rows[0].id;
      firstName = existing.rows[0].first_name;
      await run("UPDATE users SET google_id=$1, email_verified=1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [googleId, userId]);
    } else {
      isNew = true;
      userId = uuidv4();
      firstName = String(info.given_name || "User").slice(0,80);
      const surname = String(info.family_name || "Google").slice(0,80);
      let base = (firstName + "_" + surname).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0,40) || "user";
      let username = base;
      let suffix = 1;
      while (true) {
        const check = await query("SELECT id FROM users WHERE lower(username)=lower($1) LIMIT 1", [username]);
        if (!check.rows.length) break;
        username = base + "_" + (suffix++);
      }
      await run(
        "INSERT INTO users (id, first_name, surname, email, username, password_hash, google_id, email_verified, account_status) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'active')",
        [userId, firstName, surname, email, username, cryptoLocal.randomBytes(32).toString("hex"), googleId]
      );
      await run("INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    }

    const accessToken = jwt.sign(
      { sub: userId, type: "access" },
      envLocal.jwt.secret,
      { expiresIn: envLocal.jwt.expiresIn }
    );

    res.json({
      success: true,
      isNewUser: isNew,
      user: { id: userId, email: email, first_name: firstName },
      accessToken: accessToken
    });
  } catch (err) {
    console.error("[GOOGLE-LOGIN]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- ACCOUNT DELETION ---------- */

app.post("/api/v1/me/delete-confirm", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });

    let userId = null;
    try {
      const payload = jwt.verify(authHeader.slice(7), envLocal.jwt.secret);
      userId = payload.sub;
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const u = await query("SELECT email, first_name FROM users WHERE id=$1 LIMIT 1", [userId]);
    if (!u.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    const user = u.rows[0];

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = cryptoA.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await run(
      "INSERT INTO verification_codes (id, user_id, channel, destination, code_hash, purpose, expires_at) VALUES ($1,$2,'email',$3,$4,'account_delete',$5)",
      [uuidv4(), userId, user.email, codeHash, expiresAt]
    );

    const html = buildVerificationEmail(code, user.first_name);
    const result = await sendBrevoEmail(user.email, "Confirm your Connecto account deletion", html);
    if (!result.sent) return res.status(502).json({ success: false, error: "EMAIL_SEND_FAILED", details: result });

    res.json({ success: true, message: "Confirmation code sent to " + user.email });
  } catch (err) {
    console.error("[DELETE-CONFIRM]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/me", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });

    let userId = null;
    try {
      const payload = jwt.verify(authHeader.slice(7), envLocal.jwt.secret);
      userId = payload.sub;
    } catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const code = String(req.body.code || "");
    if (!code) return res.status(400).json({ success: false, error: "CODE_REQUIRED" });

    const codeHash = cryptoA.createHash("sha256").update(code).digest("hex");
    const r = await query(
      "SELECT * FROM verification_codes WHERE user_id=$1 AND code_hash=$2 AND purpose='account_delete' AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1",
      [userId, codeHash]
    );
    if (!r.rows.length) return res.status(400).json({ success: false, error: "INVALID_OR_EXPIRED_CODE" });

    await run("UPDATE verification_codes SET used_at=CURRENT_TIMESTAMP WHERE id=$1", [r.rows[0].id]);
    await run("UPDATE users SET deleted_at=CURRENT_TIMESTAMP, account_status='deleted' WHERE id=$1", [userId]);
    await run("UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1", [userId]);
    await run("UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1", [userId]);

    res.json({ success: true, message: "Account deleted." });
  } catch (err) {
    console.error("[DELETE-ME]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   BACKGROUND JOB — retry pending verification emails every 60s
   ==========================================================*/

let __patchAInterval = null;

function startPatchARetryJob() {
  if (__patchAInterval) return;
  __patchAInterval = setInterval(async () => {
    try {
      const { query, run } = require("./src/db");
      const { v4: uuidv4 } = require("uuid");

      const pending = await query(
        "SELECT id, email, first_name FROM users WHERE email_verified=0 AND account_status='active' AND verification_pending=1 LIMIT 20"
      );
      if (!pending.rows.length) return;

      for (const u of pending.rows) {
        const recent = await query(
          "SELECT COUNT(*) AS c FROM verification_codes WHERE user_id=$1 AND purpose='email_verify' AND created_at > datetime('now','-1 hour')",
          [u.id]
        );
        if (Number(recent.rows[0].c || 0) >= 2) continue;

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const codeHash = cryptoA.createHash("sha256").update(code).digest("hex");
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await run(
          "INSERT INTO verification_codes (id, user_id, channel, destination, code_hash, purpose, expires_at) VALUES ($1,$2,'email',$3,$4,'email_verify',$5)",
          [uuidv4(), u.id, u.email, codeHash, expiresAt]
        );

        const html = buildVerificationEmail(code, u.first_name);
        const result = await sendBrevoEmail(u.email, "Your Connecto verification code", html);

        if (result.sent) {
          await run("UPDATE users SET verification_pending=0, verify_grace_started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1", [u.id]);
          console.log("[PATCH-A RETRY] Sent verification to", u.email);
        }
      }
    } catch (e) {
      console.error("[PATCH-A RETRY JOB]", e.message);
    }
  }, 60000);
}

if (typeof app !== "undefined") {
  startPatchARetryJob();
}
/* ============================================================
   PATCH B — PROFILES, SEARCH, MUTE, NOTIFICATION PREFS
   Uses existing helpers: cryptoA, sha256Hex, sendBrevoEmail
   ==========================================================*/

/* ---------- PUBLIC PROFILE VIEW ---------- */

app.get("/api/v1/users/by-username/:username", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const u = await query(
      "SELECT id, first_name, surname, username, bio, category, country, state, gender, profile_photo_media_id, cover_photo_media_id, account_status FROM users WHERE lower(username)=lower($1) AND deleted_at IS NULL LIMIT 1",
      [req.params.username]
    );
    if (!u.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    res.json({ success: true, user: u.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/users/:id", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const u = await query(
      "SELECT id, first_name, surname, username, bio, category, country, state, gender, profile_photo_media_id, cover_photo_media_id, account_status FROM users WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
      [req.params.id]
    );
    if (!u.rows.length) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    res.json({ success: true, user: u.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/users/:id/posts", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const limit = Math.min(Number(req.query.limit || 20), 50);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const r = await query(
      "SELECT p.*, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM posts p JOIN users u ON u.id = p.author_id WHERE p.author_id=$1 AND p.deleted_at IS NULL AND p.audience='public' ORDER BY p.created_at DESC LIMIT $2 OFFSET $3",
      [req.params.id, limit, offset]
    );
    res.json({ success: true, posts: r.rows, pagination: { limit, offset } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/users/:id/followers", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const r = await query(
      "SELECT u.id, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id=$1 ORDER BY f.created_at DESC LIMIT $2",
      [req.params.id, limit]
    );
    res.json({ success: true, followers: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/users/:id/following", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const r = await query(
      "SELECT u.id, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id=$1 ORDER BY f.created_at DESC LIMIT $2",
      [req.params.id, limit]
    );
    res.json({ success: true, following: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/users/:id/stats", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const followers = await query("SELECT COUNT(*) AS c FROM follows WHERE following_id=$1", [req.params.id]);
    const following = await query("SELECT COUNT(*) AS c FROM follows WHERE follower_id=$1", [req.params.id]);
    const posts = await query("SELECT COUNT(*) AS c FROM posts WHERE author_id=$1 AND deleted_at IS NULL", [req.params.id]);
    const friends = await query("SELECT COUNT(*) AS c FROM friendships WHERE user_a_id=$1", [req.params.id]);
    res.json({
      success: true,
      stats: {
        followers: Number(followers.rows[0].c || 0),
        following: Number(following.rows[0].c || 0),
        posts: Number(posts.rows[0].c || 0),
        friends: Number(friends.rows[0].c || 0)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/users/:id/contributed", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const r = await query(
      "SELECT om.organization_id, o.name AS organization_name, om.role, om.joined_at FROM organization_members om JOIN organizations o ON o.id = om.organization_id WHERE om.user_id=$1 ORDER BY om.joined_at DESC",
      [req.params.id]
    );
    res.json({ success: true, contributions: r.rows });
  } catch (err) {
    // If organizations table doesn't exist yet, return empty
    res.json({ success: true, contributions: [] });
  }
});

/* ---------- SEARCH ---------- */

app.get("/api/v1/search/users", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) return res.json({ success: true, users: [] });
    const r = await query(
      "SELECT id, first_name, surname, username, bio, category, country, profile_photo_media_id FROM users WHERE account_status='active' AND deleted_at IS NULL AND (lower(username) LIKE lower($1) OR lower(first_name) LIKE lower($1) OR lower(surname) LIKE lower($1)) ORDER BY created_at DESC LIMIT $2",
      ["%" + q + "%", limit]
    );
    res.json({ success: true, users: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/search/posts", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) return res.json({ success: true, posts: [] });
    const r = await query(
      "SELECT p.id, p.text, p.author_id, p.created_at, u.username, u.first_name, u.surname, u.profile_photo_media_id FROM posts p JOIN users u ON u.id = p.author_id WHERE p.deleted_at IS NULL AND p.audience='public' AND lower(p.text) LIKE lower($1) ORDER BY p.created_at DESC LIMIT $2",
      ["%" + q + "%", limit]
    );
    res.json({ success: true, posts: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/search/tags", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ success: true, tags: [] });
    const r = await query(
      "SELECT id, text, author_id, created_at FROM posts WHERE deleted_at IS NULL AND audience='public' AND lower(text) LIKE lower($1) ORDER BY created_at DESC LIMIT 50",
      ["%#" + q + "%"]
    );
    res.json({ success: true, tags: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- MUTE ---------- */

app.post("/api/v1/users/:id/mute", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    if (userId === req.params.id) return res.status(400).json({ success: false, error: "CANNOT_MUTE_SELF" });
    await run("INSERT INTO mutes (id, muter_id, muted_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [uuidv4(), userId, req.params.id]);
    res.json({ success: true, muted: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/users/:id/mute", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    await run("DELETE FROM mutes WHERE muter_id=$1 AND muted_id=$2", [userId, req.params.id]);
    res.json({ success: true, muted: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ---------- MY FOLLOWERS / FOLLOWING / FRIEND REQUESTS ---------- */

app.get("/api/v1/me/followers", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const r = await query(
      "SELECT u.id, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id=$1 ORDER BY f.created_at DESC LIMIT $2",
      [userId, limit]
    );
    res.json({ success: true, followers: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/me/following", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const r = await query(
      "SELECT u.id, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id=$1 ORDER BY f.created_at DESC LIMIT $2",
      [userId, limit]
    );
    res.json({ success: true, following: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/me/friend-requests", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const r = await query(
      "SELECT fr.id, fr.sender_id, fr.status, fr.created_at, u.first_name, u.surname, u.username, u.profile_photo_media_id FROM friend_requests fr JOIN users u ON u.id = fr.sender_id WHERE fr.receiver_id=$1 AND fr.status='pending' ORDER BY fr.created_at DESC",
      [userId]
    );
    res.json({ success: true, requests: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/me/friend-requests/:id", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    await run("UPDATE friend_requests SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND (sender_id=$2 OR receiver_id=$2)", [req.params.id, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- NOTIFICATION PREFERENCES ---------- */

app.get("/api/v1/notifications/preferences", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const r = await query("SELECT * FROM notification_preferences WHERE user_id=$1 LIMIT 1", [userId]);
    if (!r.rows.length) {
      return res.json({
        success: true,
        preferences: {
          push_enabled: 1,
          email_enabled: 1,
          follows_enabled: 1,
          friend_requests_enabled: 1,
          messages_enabled: 1,
          comments_enabled: 1,
          reactions_enabled: 1
        }
      });
    }
    res.json({ success: true, preferences: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/api/v1/notifications/preferences", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const allowed = ["push_enabled","email_enabled","follows_enabled","friend_requests_enabled","messages_enabled","comments_enabled","reactions_enabled"];
    const fields = [];
    const values = [];
    let n = 1;

    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        fields.push(k + "=$" + n++);
        values.push(req.body[k] ? 1 : 0);
      }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: "NO_FIELDS" });

    await run("INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    values.push(userId);
    await run("UPDATE notification_preferences SET " + fields.join(", ") + ", updated_at=CURRENT_TIMESTAMP WHERE user_id=$" + n, values);

    const r = await require("./src/db").query("SELECT * FROM notification_preferences WHERE user_id=$1 LIMIT 1", [userId]);
    res.json({ success: true, preferences: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/notifications/:id/read", async (req, res) => {
  try {
    const { run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    await run("UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=$1 AND recipient_id=$2", [req.params.id, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- CHAT EXTRAS ---------- */

app.get("/api/v1/chat/conversations/:id", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const member = await query("SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2", [req.params.id, userId]);
    if (!member.rows.length) return res.status(403).json({ success: false, error: "NOT_A_MEMBER" });
    const c = await query("SELECT * FROM conversations WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    res.json({ success: true, conversation: c.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/messages/:id/read", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const m = await query("SELECT * FROM messages WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    const member = await query("SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2", [m.rows[0].conversation_id, userId]);
    if (!member.rows.length) return res.status(403).json({ success: false, error: "NOT_A_MEMBER" });
    await run("UPDATE messages SET seen_at=COALESCE(seen_at,CURRENT_TIMESTAMP) WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/messages/:id/reactions", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const type = String(req.body.type || "like").slice(0, 20);
    await run(
      "INSERT INTO message_reactions (id, message_id, user_id, type) VALUES ($1,$2,$3,$4) ON CONFLICT(message_id,user_id) DO UPDATE SET type=excluded.type",
      [uuidv4(), req.params.id, userId, type]
    );
    res.json({ success: true, reaction: type });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/messages/:id", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }
    const m = await query("SELECT * FROM messages WHERE id=$1 AND sender_id=$2 LIMIT 1", [req.params.id, userId]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND_OR_NOT_OWNER" });
    await run("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP, body=NULL WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- MUTES TABLE AUTO-CREATE ---------- */

(async () => {
  try {
    const { run } = require("./src/db");
    await run("CREATE TABLE IF NOT EXISTS mutes (id TEXT PRIMARY KEY, muter_id TEXT NOT NULL, muted_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(muter_id, muted_id))");
    await run("CREATE INDEX IF NOT EXISTS idx_mutes_muter ON mutes(muter_id)");
    console.log("[PATCH-B] mutes table ready");
  } catch (e) {
    console.error("[PATCH-B] mutes table:", e.message);
  }
})();

/* ============================================================
   PATCH C — MEDIA UPLOAD (ImgBB for profile, B2 for posts)
   Uses: getProviderCredential() from server.js
   ==========================================================*/

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

async function getActiveStorageCredential() {
  try {
    const { query } = require("./src/db");
    const r = await query(
      "SELECT * FROM provider_credentials WHERE category='storage' AND is_active=1 ORDER BY is_primary DESC, priority ASC LIMIT 5"
    );
    if (!r.rows.length) return [];
    const out = [];
    for (const row of r.rows) {
      try {
        const KEY = process.env.CONTROL_ENCRYPTION_KEY;
        if (!KEY) continue;
        const raw = Buffer.from(row.credentials_enc, "base64");
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const data = raw.subarray(28);
        const decipher = cryptoA.createDecipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
        const cred = JSON.parse(decrypted.toString("utf8"));
        out.push({ id: row.id, provider: row.provider, cred: cred });
      } catch (e) { /* skip broken */ }
    }
    return out;
  } catch (e) {
    return [];
  }
}

function makeB2Client(cred) {
  return new S3Client({
    endpoint: cred.endpoint,
    region: cred.region,
    credentials: {
      accessKeyId: cred.keyId,
      secretAccessKey: cred.applicationKey
    },
    forcePathStyle: true
  });
}

async function uploadToImgBB(cred, base64, name) {
  const form = new FormData();
  form.append("image", base64);
  if (name) form.append("name", name);
  form.append("key", cred.apiKey || cred.api_key);

  const resp = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: form
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error("ImgBB: " + (data.error && data.error.message ? data.error.message : "upload failed"));
  }
  return {
    url: data.data.url,
    thumb: data.data.thumb && data.data.thumb.url,
    delete_url: data.data.delete_url,
    storage_key: data.data.id
  };
}

async function signB2Put(cred, key, contentType) {
  const s3 = makeB2Client(cred);
  const cmd = new PutObjectCommand({
    Bucket: cred.bucket,
    Key: key,
    ContentType: contentType
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });
  return url;
}

async function signB2Get(cred, key, seconds) {
  const s3 = makeB2Client(cred);
  const cmd = new GetObjectCommand({
    Bucket: cred.bucket,
    Key: key
  });
  return getSignedUrl(s3, cmd, { expiresIn: seconds || 3600 });
}

/* ---------- PROFILE PHOTO UPLOAD (ImgBB) ---------- */

app.post("/api/v1/media/profile-upload", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const { image_base64, mime_type, kind } = req.body;
    if (!image_base64 || !mime_type) return res.status(400).json({ success: false, error: "IMAGE_AND_MIME_REQUIRED" });
    if (!mime_type.startsWith("image/")) return res.status(400).json({ success: false, error: "ONLY_IMAGES_ALLOWED" });

    const creds = await getActiveStorageCredential();
    const imgbb = creds.find(function (c) { return c.provider === "imgbb"; });
    if (!imgbb) return res.status(503).json({ success: false, error: "NO_IMGBB_CREDENTIAL" });

    const uploaded = await uploadToImgBB(imgbb.cred, image_base64, "connecto-" + userId);

    const mediaId = uuidv4();
    await run(
      "INSERT INTO media (id, owner_id, type, mime_type, storage_key, processing_status, visibility) VALUES ($1,$2,'image',$3,$4,'ready','public')",
      [mediaId, userId, mime_type, uploaded.url]
    );

    const field = kind === "cover" ? "cover_photo_media_id" : "profile_photo_media_id";
    await run("UPDATE users SET " + field + "=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [uploaded.url, userId]);

    res.json({
      success: true,
      media_id: mediaId,
      url: uploaded.url,
      thumb: uploaded.thumb,
      kind: kind || "profile"
    });
  } catch (err) {
    console.error("[PROFILE-UPLOAD]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- POST MEDIA UPLOAD (B2 presigned) ---------- */

app.post("/api/v1/media/upload-url", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const { v4: uuidv4 } = require("uuid");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const { content_type, file_size, media_type } = req.body;
    if (!content_type) return res.status(400).json({ success: false, error: "CONTENT_TYPE_REQUIRED" });

    const isImage = content_type.startsWith("image/");
    const isVideo = content_type.startsWith("video/");
    if (!isImage && !isVideo) return res.status(400).json({ success: false, error: "UNSUPPORTED_MEDIA_TYPE" });

    if (isImage && file_size && file_size > 25 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "IMAGE_TOO_LARGE" });
    }
    if (isVideo && file_size && file_size > 500 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "VIDEO_TOO_LARGE" });
    }

    const creds = await getActiveStorageCredential();
    const b2 = creds.find(function (c) { return c.provider === "b2"; });
    if (!b2) return res.status(503).json({ success: false, error: "NO_B2_CREDENTIAL" });

    const ext = content_type.split("/")[1] || "bin";
    const key = "users/" + userId + "/" + Date.now() + "-" + uuidv4() + "." + ext;

    const putUrl = await signB2Put(b2.cred, key, content_type);

    const mediaId = uuidv4();
    await run(
      "INSERT INTO media (id, owner_id, type, mime_type, size, storage_key, processing_status, visibility) VALUES ($1,$2,$3,$4,$5,$6,'pending','private')",
      [mediaId, userId, isImage ? "image" : "video", content_type, file_size || 0, key]
    );

    res.json({
      success: true,
      media_id: mediaId,
      upload_url: putUrl,
      storage_key: key,
      method: "PUT",
      headers: { "Content-Type": content_type },
      expires_in: 900
    });
  } catch (err) {
    console.error("[UPLOAD-URL]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/media/:id/complete", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const m = await query("SELECT * FROM media WHERE id=$1 AND owner_id=$2 LIMIT 1", [req.params.id, userId]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });

    await run("UPDATE media SET processing_status='ready' WHERE id=$1", [req.params.id]);

    const creds = await getActiveStorageCredential();
    const b2 = creds.find(function (c) { return c.provider === "b2"; });
    let viewUrl = null;
    if (b2) {
      try { viewUrl = await signB2Get(b2.cred, m.rows[0].storage_key, 3600); } catch (e) {}
    }

    res.json({ success: true, media_id: req.params.id, view_url: viewUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/media/:id", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const m = await query("SELECT * FROM media WHERE id=$1 LIMIT 1", [req.params.id]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });
    const row = m.rows[0];

    if (row.storage_key && row.storage_key.indexOf("http") === 0) {
      return res.json({ success: true, media: row, view_url: row.storage_key });
    }

    const creds = await getActiveStorageCredential();
    const b2 = creds.find(function (c) { return c.provider === "b2"; });
    if (!b2) return res.status(503).json({ success: false, error: "NO_B2_CREDENTIAL" });

    const viewUrl = await signB2Get(b2.cred, row.storage_key, 3600);
    res.json({ success: true, media: row, view_url: viewUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/media/:id/attach", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const postId = String(req.body.post_id || "");
    if (!postId) return res.status(400).json({ success: false, error: "POST_ID_REQUIRED" });

    const m = await query("SELECT * FROM media WHERE id=$1 AND owner_id=$2 LIMIT 1", [req.params.id, userId]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });

    const p = await query("SELECT * FROM posts WHERE id=$1 AND author_id=$2 LIMIT 1", [postId, userId]);
    if (!p.rows.length) return res.status(404).json({ success: false, error: "POST_NOT_FOUND_OR_NOT_OWNER" });

    await run("UPDATE media SET post_id=$1, visibility='public' WHERE id=$2", [postId, req.params.id]);

    res.json({ success: true, media_id: req.params.id, post_id: postId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/media/:id", async (req, res) => {
  try {
    const { query, run } = require("./src/db");
    const jwt = require("jsonwebtoken");
    const envLocal = require("./src/config/env");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    let userId = null;
    try { const p = jwt.verify(authHeader.slice(7), envLocal.jwt.secret); userId = p.sub; }
    catch (e) { return res.status(401).json({ success: false, error: "INVALID_SESSION" }); }

    const m = await query("SELECT * FROM media WHERE id=$1 AND owner_id=$2 LIMIT 1", [req.params.id, userId]);
    if (!m.rows.length) return res.status(404).json({ success: false, error: "NOT_FOUND" });

    const row = m.rows[0];
    if (row.storage_key && row.storage_key.indexOf("http") !== 0) {
      try {
        const creds = await getActiveStorageCredential();
        const b2 = creds.find(function (c) { return c.provider === "b2"; });
        if (b2) {
          const s3 = makeB2Client(b2.cred);
          await s3.send(new DeleteObjectCommand({ Bucket: b2.cred.bucket, Key: row.storage_key }));
        }
      } catch (e) { /* best effort */ }
    }

    await run("UPDATE media SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ============================================================
   PATCH C — PART 2
   Schema check, error handlers, cleanup job
   ==========================================================*/

/* ---------- MEDIA SCHEMA SAFETY CHECK ---------- */

(async () => {
  try {
    const { run } = require("./src/db");

    const cols = [
      { name: "processing_status", type: "TEXT DEFAULT 'pending'" },
      { name: "visibility", type: "TEXT DEFAULT 'private'" },
      { name: "thumbnail_key", type: "TEXT" },
      { name: "width", type: "INTEGER" },
      { name: "height", type: "INTEGER" },
      { name: "duration", type: "REAL" }
    ];

    for (const c of cols) {
      try {
        await run("ALTER TABLE media ADD COLUMN " + c.name + " " + c.type);
      } catch (e) {
        /* column already exists — ignore */
      }
    }

    await run("CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id)");

    console.log("[PATCH-C] media schema ready");
  } catch (e) {
    console.error("[PATCH-C] media schema:", e.message);
  }
})();

/* ---------- ORPHAN MEDIA CLEANUP JOB ---------- */
/* Deletes media rows that are older than 24h and were never attached to a post */

let __patchCInterval = null;

function startPatchCCleanupJob() {
  if (__patchCInterval) return;

  __patchCInterval = setInterval(async () => {
    try {
      const { query, run } = require("./src/db");

      const orphans = await query(
        "SELECT id, storage_key FROM media WHERE post_id IS NULL AND processing_status='pending' AND created_at < datetime('now','-1 day') LIMIT 50"
      );

      if (!orphans.rows.length) return;

      const creds = await getActiveStorageCredential();
      const b2 = creds.find(function (c) { return c.provider === "b2"; });

      for (const row of orphans.rows) {
        if (b2 && row.storage_key && row.storage_key.indexOf("http") !== 0) {
          try {
            const s3 = makeB2Client(b2.cred);
            await s3.send(new DeleteObjectCommand({ Bucket: b2.cred.bucket, Key: row.storage_key }));
          } catch (e) { /* best effort */ }
        }
        await run("UPDATE media SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [row.id]);
      }

      console.log("[PATCH-C CLEANUP] Removed", orphans.rows.length, "orphan media");
    } catch (e) {
      console.error("[PATCH-C CLEANUP]", e.message);
    }
  }, 3600000); /* every hour */
}

if (typeof app !== "undefined") {
  startPatchCCleanupJob();
}

/* ---------- PROVIDER-SPECIFIC TEST ENDPOINTS ---------- */

app.post("/api/v1/media/test-imgbb", async (req, res) => {
  try {
    const creds = await getActiveStorageCredential();
    const imgbb = creds.find(function (c) { return c.provider === "imgbb"; });
    if (!imgbb) return res.status(503).json({ success: false, error: "NO_IMGBB_CREDENTIAL" });

    const tiny =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    const result = await uploadToImgBB(imgbb.cred, tiny, "connecto-test");
    res.json({ success: true, url: result.url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/media/test-b2", async (req, res) => {
  try {
    const creds = await getActiveStorageCredential();
    const b2 = creds.find(function (c) { return c.provider === "b2"; });
    if (!b2) return res.status(503).json({ success: false, error: "NO_B2_CREDENTIAL" });

    const key = "connecto-test/" + Date.now() + ".txt";
    console.log("[test-b2] cred:", JSON.stringify({endpoint: b2.cred.endpoint, region: b2.cred.region, bucket: b2.cred.bucket, hasKeyId: !!b2.cred.keyId, hasAppKey: !!b2.cred.applicationKey}));
    const url = await signB2Put(b2.cred, key, "text/plain");

    res.json({ success: true, upload_url: url, storage_key: key });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.use("/api/v1", v1);
app.use("/control-api", controlRouter);

app.use((err, req, res, next) => {
  console.error("[CONNECTO ERROR]", err);

  if (err.name === "ZodError") {
    return res.status(400).json({
      success: false,
      error: "Invalid request",
      details: err.issues
    });
  }

  if (err.code === "23505" || err.code === "SQLITE_CONSTRAINT") {
    return res.status(409).json({
      success: false,
      error: "A record with those values already exists"
    });
  }

  res.status(500).json({
    success: false,
    error: "Internal server error"
  });
});

async function start() {
  try {
    await query("SELECT 1 AS ok");

    console.log("[CONNECTO] Turso connected.");

    attachRealtime(server);

    server.listen(env.port, "0.0.0.0", () => {
      console.log("========================================");
      console.log("       CONNECTO COMPLETE V1 ONLINE");
      console.log("========================================");
      console.log(`HTTP: http://127.0.0.1:${env.port}`);
      console.log(`Health: http://127.0.0.1:${env.port}/api/v1/health`);
      console.log(`DB Health: http://127.0.0.1:${env.port}/api/v1/health/db`);
      console.log(`Providers: http://127.0.0.1:${env.port}/api/v1/providers/status`);
      console.log(`WebSocket: ws://127.0.0.1:${env.port}/ws`);
      console.log("========================================");
    });
  } catch (err) {
    console.error("[CONNECTO] Startup failed:", err.message);
    process.exit(1);
  }
}

start();
