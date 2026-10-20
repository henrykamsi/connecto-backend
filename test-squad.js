require('dotenv').config();
const { query } = require('./src/db');
const jwt = require('jsonwebtoken');
const env = require('./src/config/env');
const crypto = require('crypto');

(async () => {
  // Get a real user
  const u = await query("SELECT id, email, username FROM users WHERE account_status='active' LIMIT 1");
  if (!u.rows.length) { console.log('No users'); process.exit(1); }
  const user = u.rows[0];
  console.log('Using user:', user.username, user.email);

  // Sign a token for them
  const token = jwt.sign({ sub: user.id, type: 'access' }, env.jwt.secret, { expiresIn: '5m' });
  console.log('Token generated (5 min)');

  // Find a creator with Stars enabled
  const c = await query("SELECT user_id, price_ngn, button_label FROM stars_config WHERE enabled=1 LIMIT 1");
  if (!c.rows.length) { console.log('No creators with Stars enabled'); process.exit(1); }
  const creatorId = c.rows[0].user_id;
  console.log('Creator with Stars:', creatorId, '| price:', c.rows[0].price_ngn);

  // Call support init locally
  const resp = await fetch('http://127.0.0.1:3000/api/v1/stars/support/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ creator_id: creatorId })
  });
  const data = await resp.json();
  console.log('=== SERVER RESPONSE ===');
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
