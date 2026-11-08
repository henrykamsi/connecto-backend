require("dotenv").config();

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",

  port: Number(process.env.PORT || 3000),

  appName: process.env.APP_NAME || "Connecto",

  apiVersion: process.env.API_VERSION || "v1",

  turso: {
    databaseUrl: required("TURSO_DATABASE_URL"),
    authToken: required("TURSO_AUTH_TOKEN"),

    secondaryDatabaseUrl:
      process.env.TURSO_SECOND_DATABASE_URL || "",

    secondaryAuthToken:
      process.env.TURSO_SECOND_AUTH_TOKEN || ""
  },

  jwt: {
    secret: required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN || "90d",
    refreshTokenExpiresDays:
      Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 30)
  },

  b2: {
    endpoint: process.env.B2_ENDPOINT || "",
    region: process.env.B2_REGION || "",
    bucket: process.env.B2_BUCKET || "",
    keyId: process.env.B2_KEY_ID || "",
    applicationKey: process.env.B2_APPLICATION_KEY || ""
  },

  fcm: {
    projectId: process.env.FCM_PROJECT_ID || "",
    clientEmail: process.env.FCM_CLIENT_EMAIL || "",
    privateKey: process.env.FCM_PRIVATE_KEY || ""
  },

  brevo: {
    apiKey: process.env.BREVO_API_KEY || "",
    senderEmail: process.env.BREVO_SENDER_EMAIL || "",
    senderName: process.env.BREVO_SENDER_NAME || "Connecto",
    replyToEmail: process.env.BREVO_REPLY_TO_EMAIL || ""
  },

  corsOrigins: process.env.CORS_ORIGINS || "*",

  maxImageSizeMb:
    Number(process.env.MAX_IMAGE_SIZE_MB || 15),

  maxVideoSizeMb:
    Number(process.env.MAX_VIDEO_SIZE_MB || 500),

  websocketEnabled:
    String(process.env.WS_ENABLED || "true") === "true"
};
