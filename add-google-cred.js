require('dotenv').config();
const { query, run } = require('./src/db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const CLIENT_ID = '709693242234-7kusefcnqf0rte5p006qobnsuog0t4ur.apps.googleusercontent.com';
const MASTER = process.env.CONTROL_ENCRYPTION_KEY;

if (!MASTER) {
  console.error('CONTROL_ENCRYPTION_KEY missing in .env');
  process.exit(1);
}

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(MASTER, 'hex'), iv);
const encrypted = Buffer.concat([
  cipher.update(JSON.stringify({ clientId: CLIENT_ID })),
  cipher.final()
]);
const tag = cipher.getAuthTag();
const credentials_enc = Buffer.concat([iv, tag, encrypted]).toString('base64');

(async () => {
  const existing = await query(
    "SELECT id FROM provider_credentials WHERE category='auth' AND provider='google' LIMIT 1"
  );

  if (existing.rows.length) {
    await run(
      "UPDATE provider_credentials SET credentials_enc=$1, is_active=1, is_primary=1, updated_at=CURRENT_TIMESTAMP WHERE id=$2",
      [credentials_enc, existing.rows[0].id]
    );
    console.log('Updated existing Google credential');
  } else {
    await run(
      "INSERT INTO provider_credentials (id, category, provider, label, credentials_enc, priority, is_active, is_primary, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [uuidv4(), 'auth', 'google', 'Connecto Google', credentials_enc, 0, 1, 1, 'ready']
    );
    console.log('Inserted new Google credential');
  }

  const check = await query(
    "SELECT id, is_active, is_primary FROM provider_credentials WHERE category='auth' AND provider='google'"
  );
  console.log(JSON.stringify(check.rows, null, 2));
  process.exit(0);
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
