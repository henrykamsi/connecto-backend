require('dotenv').config();
const { query } = require('./src/db');
(async () => {
  const all = await query("SELECT id, username, email FROM users ORDER BY created_at DESC LIMIT 10");
  console.log('Total recent users:', all.rows.length);
  all.rows.forEach(u => {
    console.log('  id:', JSON.stringify(u.id), '| username:', u.username, '| email:', u.email);
  });

  const nullCount = await query("SELECT COUNT(*) AS c FROM users WHERE id IS NULL");
  console.log('Users with NULL id:', nullCount.rows[0].c);

  const okCount = await query("SELECT COUNT(*) AS c FROM users WHERE id IS NOT NULL");
  console.log('Users with valid id:', okCount.rows[0].c);

  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
