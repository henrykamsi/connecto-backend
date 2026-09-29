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
