require('dotenv').config();
const { query } = require('./src/db');
const jwt = require('jsonwebtoken');
const env = require('./src/config/env');

(async () => {
  const u = await query("SELECT id, username FROM users WHERE username='kamsi_henry' LIMIT 1");
  if (u.rows.length === 0) { console.log('Test user not found'); process.exit(1); }
  const userId = u.rows[0].id;
  console.log('User:', u.rows[0].username, '| id:', userId);

  const all = await query("SELECT user_id, price_ngn FROM stars_config WHERE enabled=1");
  const others = all.rows.filter(r => r.user_id !== userId);
  if (others.length === 0) {
    console.log('No other creator with Stars enabled — list of enabled creators:');
    console.log(JSON.stringify(all.rows, null, 2));
    process.exit(1);
  }
  const creatorId = others[0].user_id;
  console.log('Creator:', creatorId, '| price:', others[0].price_ngn);

  const token = jwt.sign({ sub: userId, type: 'access' }, env.jwt.secret, { expiresIn: '5m' });

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
