const admin = require('firebase-admin');
const crypto = require('crypto');
const env = require('../config/env');

let ready = false;

async function getFcmCreds() {
  try {
    const { query } = require('../db');
    const r = await query(
      "SELECT * FROM provider_credentials WHERE category='push' AND provider='fcm' AND is_active=1 ORDER BY is_primary DESC, priority ASC LIMIT 1"
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
        const decrypted = Buffer.concat([
          decipher.update(data),
          decipher.final()
        ]);
        const cred = JSON.parse(decrypted.toString("utf8"));
        return {
          projectId: cred.projectId || "",
          clientEmail: cred.clientEmail || "",
          privateKey: String(cred.privateKey || "").replace(/\\n/g, "\n")
        };
      }
    }
  } catch (e) {
    console.error("[FCM] panel read failed:", e.message);
  }
  return {
    projectId: env.fcm.projectId,
    clientEmail: env.fcm.clientEmail,
    privateKey: String(env.fcm.privateKey || "").replace(/\\n/g, "\n")
  };
}

async function initFCM() {
  if (ready) return true;

  const creds = await getFcmCreds();

  if (!creds.projectId || !creds.clientEmail || !creds.privateKey) {
    return false;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: creds.projectId,
        clientEmail: creds.clientEmail,
        privateKey: creds.privateKey
      })
    });
  }

  ready = true;
  return true;
}

async function sendToUser(userId, notification, data = {}) {
  try {
    const ok = await initFCM();
    if (!ok) {
      return { sent: false, reason: "FCM not configured" };
    }

    const { query } = require('../db');

    const result = await query(
      "SELECT fcm_token FROM device_tokens WHERE user_id=$1 AND active=1",
      [userId]
    );

    if (!result.rows.length) {
      return { sent: false, reason: "No active device tokens" };
    }

    const tokens = result.rows.map(x => x.fcm_token);

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification,
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      )
    });

    return {
      sent: true,
      successCount: response.successCount,
      failureCount: response.failureCount
    };
  } catch (e) {
    console.error("[FCM sendToUser]", e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { initFCM, sendToUser, getFcmCreds };
