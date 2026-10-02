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
