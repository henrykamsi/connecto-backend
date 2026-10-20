require('dotenv').config();
const { query, run } = require('./src/db');
const { v4: uuidv4 } = require('uuid');

(async () => {
  const broken = await query("SELECT username, email FROM users WHERE id IS NULL");
  console.log('Broken users found:', broken.rows.length);

  for (const u of broken.rows) {
    const newId = uuidv4();
    await run(
      "UPDATE users SET id=$1 WHERE username=$2 AND id IS NULL",
      [newId, u.username]
    );
    console.log('  Fixed:', u.username, '-> id:', newId);
  }

  const check = await query("SELECT COUNT(*) AS c FROM users WHERE id IS NULL");
  console.log('Remaining NULL ids:', check.rows[0].c);
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
