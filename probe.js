require("dotenv").config();
const { query } = require("./src/db");
const jwt = require("jsonwebtoken");
const envLocal = require("./src/config/env");

(async () => {
  console.log("[uuid] typeof require('uuid'):", typeof require("uuid"));
  console.log("[uuid] typeof require('uuid').v4:", typeof require("uuid").v4);

  console.log("[jwt] secret length:", (envLocal.jwt.secret || "").length);

  try {
    const c = await query("PRAGMA table_info(conversations)");
    console.log("[schema conversations]", c.rows.map(r => r.name).join(", "));
  } catch (e) { console.log("[schema conversations ERROR]", e.message); }

  try {
    const m = await query("PRAGMA table_info(conversation_members)");
    console.log("[schema conversation_members]", m.rows.map(r => r.name).join(", "));
  } catch (e) { console.log("[schema conversation_members ERROR]", e.message); }

  process.exit(0);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
