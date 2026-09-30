require("dotenv").config();
const { query } = require("./src/db");

async function main() {
  const r = await query(
    `SELECT id, event_type, source, status, created_at
     FROM webhook_events
     ORDER BY created_at DESC
     LIMIT 20`
  );

  console.log("Total rows returned:", r.rows.length);
  for (const row of r.rows) {
    console.log(row.created_at, "|", row.event_type, "|", row.source, "|", row.status);
  }

  const c = await query(`SELECT COUNT(*) as c FROM webhook_events`);
  console.log("Total in table:", c.rows[0].c);

  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
