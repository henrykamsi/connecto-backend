require('dotenv').config();
const { query } = require('./src/db');
const jwt = require('jsonwebtoken');
const env = require('./src/config/env');

(async () => {
  // Find any two different users
  const all = await query("SELECT id, username FROM users WHERE account_status='active' LIMIT 2");
  if (all.rows.length < 2) {
    console.log('Need at least 2 active users in DB');
    process.exit(1);
  }
  const supporter = all.rows[0];
  const creator  = all.rows[1];
  console.log('Supporter:', supporter.username, supporter.id);
  console.log('Creator:  ', creator.username, creator.id);

  // Temporarily enable Stars for the creator so we can test Squad
  await query(
    "INSERT INTO stars_config (user_id, price_ngn, button_label, enabled) VALUES ($1, 500, 'Support us', 1) ON CONFLICT(user_id) DO UPDATE SET enabled=1",
    [creator.id]
  );

  const token = jwt.sign({ sub: supporter.id, type: 'access' }, env.jwt.secret, { expiresIn: '5m' });

  const resp = await fetch('http://127.0.0.1:3000/api/v1/stars/support/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ creator_id: creator.id })
  });
  const data = await resp.json();
  console.log('=== SERVER RESPONSE ===');
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
