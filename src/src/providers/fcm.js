const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
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

  if (getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId: config.fcm.projectId,
        clientEmail: config.fcm.clientEmail,
        privateKey: config.fcm.privateKey.replace(/\\n/g, "\n")
      })
    });
  }

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

  const response = await getMessaging().send({
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
