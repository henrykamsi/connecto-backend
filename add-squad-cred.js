require('dotenv').config();
const readline = require('readline');
const { query, run } = require('./src/db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const MASTER = process.env.CONTROL_ENCRYPTION_KEY;
if (!MASTER) {
  console.error('CONTROL_ENCRYPTION_KEY missing in .env');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
  return new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));
}

(async () => {
  const env = await ask('Squad environment (sandbox/live) [sandbox]: ') || 'sandbox';
  const secretKey = await ask('Squad SECRET key (hidden): ');
  const publicKey = await ask('Squad PUBLIC key: ');
  const webhookSecret = await ask('Squad webhook secret (optional, Enter to skip): ');

  if (!secretKey || !publicKey) {
    console.error('Secret and public keys are required.');
    rl.close();
    process.exit(1);
  }

  const credentials = {
    secretKey: secretKey,
    publicKey: publicKey,
    webhookSecret: webhookSecret || '',
    environment: env
  };

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(MASTER, 'hex'), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials)),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const credentials_enc = Buffer.concat([iv, tag, encrypted]).toString('base64');

  const existing = await query(
    "SELECT id FROM provider_credentials WHERE category='payments' AND provider='squad' LIMIT 1"
  );

  if (existing.rows.length) {
    await run(
      "UPDATE provider_credentials SET credentials_enc=$1, is_active=1, is_primary=1, updated_at=CURRENT_TIMESTAMP WHERE id=$2",
      [credentials_enc, existing.rows[0].id]
    );
    console.log('Updated existing Squad credential');
  } else {
    await run(
      "INSERT INTO provider_credentials (id, category, provider, label, credentials_enc, priority, is_active, is_primary, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [uuidv4(), 'payments', 'squad', 'Connecto Squad', credentials_enc, 0, 1, 1, 'ready']
    );
    console.log('Inserted new Squad credential');
  }

  const check = await query(
    "SELECT id, is_active, is_primary FROM provider_credentials WHERE category='payments' AND provider='squad'"
  );
  console.log(JSON.stringify(check.rows, null, 2));
  rl.close();
  process.exit(0);
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
