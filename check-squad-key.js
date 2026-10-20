require('dotenv').config();
const { query } = require('./src/db');
const crypto = require('crypto');

(async () => {
  const r = await query("SELECT credentials_enc FROM provider_credentials WHERE provider='squad' AND is_active=1 LIMIT 1");
  if (!r.rows.length) { console.log('No active Squad credential'); process.exit(1); }

  const KEY = process.env.CONTROL_ENCRYPTION_KEY;
  const raw = Buffer.from(r.rows[0].credentials_enc, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  d.setAuthTag(tag);
  const parsed = JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));

  console.log('Environment:', parsed.environment);
  console.log('Secret key length:', (parsed.secretKey || '').length);
  console.log('Secret key prefix:', (parsed.secretKey || '').slice(0, 15));
  console.log('Public key prefix:', (parsed.publicKey || '').slice(0, 15));
  console.log('Webhook secret set:', !!parsed.webhookSecret);

  // Now try to talk to Squad directly with this key
  const env = parsed.environment === 'live' ? 'live' : 'sandbox';
  const base = env === 'live'
    ? 'https://api-d.squadco.com'
    : 'https://sandbox-api-d.squadco.com';

  console.log('Calling Squad:', base);

  const test = await fetch(base + '/transaction/initiate', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + parsed.secretKey,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({
      amount: 10000,
      email: 'test@connecto.app',
      currency: 'NGN',
      initiate_type: 'inline',
      transaction_ref: 'connecto-test-' + Date.now(),
      callback_url: 'https://connecto.app/payment-return'
    })
  });

  const body = await test.text();
  console.log('HTTP status:', test.status);
  console.log('Response body:', body.slice(0, 500));
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
