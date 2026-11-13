#!/bin/bash
set -e
cd ~/connecto

node > /tmp/patch_out.txt 2>&1 << 'ENDOFJS'
const fs = require("fs");
const { execSync } = require("child_process");
let src = fs.readFileSync("server.js", "utf8");

const patterns = [
  /app\.post\(\s*["']\/api\/v1\/chat\/conversations["']\s*,\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\}\);\s*\n/g,
  /app\.post\(\s*["']\/api\/v1\/chat\/conversations["']\s*,\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\}\);\s*\n/g,
  /app\.post\(\s*["']\/api\/v1\/chat\/conversations["']\s*,\s*function\s*\([^)]*\)\s*\{[\s\S]*?\n\}\);\s*\n/g
];
let removed = 0;
for (const p of patterns) {
  const before = src.length;
  src = src.replace(p, "");
  if (src.length !== before) removed++;
}
console.log("removed old handlers: " + removed);

const newRoute = [
  "",
  "/* [CHAT-FIX-FINAL] */",
  "app.post('/api/v1/chat/conversations', async (req, res) => {",
  "  try {",
  "    const { query, run } = require('./src/db');",
  "    const { v4: uuidv4 } = require('uuid');",
  "    const jwt = require('jsonwebtoken');",
  "    const envLocal = require('./src/config/env');",
  "    const h = req.headers.authorization || '';",
  "    if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });",
  "    let me = null;",
  "    try { me = jwt.verify(h.slice(7), envLocal.jwt.secret).sub; } catch (e) { return res.status(401).json({ success: false, error: 'INVALID_SESSION' }); }",
  "    const other = String(req.body.userId || '').trim();",
  "    if (!other) return res.status(400).json({ success: false, error: 'USER_ID_REQUIRED' });",
  "    if (other === me) return res.status(400).json({ success: false, error: 'CANNOT_CHAT_SELF' });",
  "    const ex = await query('SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id JOIN conversation_members b ON b.conversation_id=c.id WHERE c.type=\\'direct\\' AND a.user_id=$1 AND b.user_id=$2 LIMIT 1', [me, other]);",
  "    if (ex.rows.length) return res.json({ success: true, conversationId: ex.rows[0].id, reused: true });",
  "    const convId = uuidv4();",
  "    try { await run('INSERT INTO conversations (id, type) VALUES ($1, \\'direct\\')', [convId]); }",
  "    catch (e) { console.error('[CHAT-FIX-CONV]', e.message); return res.status(500).json({ success: false, error: 'CONVERSATION_INSERT_FAILED', detail: e.message }); }",
  "    try {",
  "      await run('INSERT INTO conversation_members (id, conversation_id, user_id) VALUES ($1, $2, $3)', [uuidv4(), convId, me]);",
  "      await run('INSERT INTO conversation_members (id, conversation_id, user_id) VALUES ($1, $2, $3)', [uuidv4(), convId, other]);",
  "    } catch (e) {",
  "      console.error('[CHAT-FIX-MEMBER]', e.message);",
  "      try { await run('DELETE FROM conversation_members WHERE conversation_id=$1', [convId]); } catch (_) {}",
  "      try { await run('DELETE FROM conversations WHERE id=$1', [convId]); } catch (_) {}",
  "      return res.status(500).json({ success: false, error: 'MEMBER_INSERT_FAILED', detail: e.message });",
  "    }",
  "    console.log('[CHAT-FIX] created', convId, 'between', me, 'and', other);",
  "    return res.json({ success: true, conversationId: convId });",
  "  } catch (err) {",
  "    console.error('[CHAT-FIX-UNCAUGHT]', err.message);",
  "    return res.status(500).json({ success: false, error: err.message });",
  "  }",
  "});",
  ""
].join("\n");

src = src + newRoute;
fs.writeFileSync("server.js.tmp.js", src);
try { execSync("node --check server.js.tmp.js", { stdio: "pipe" }); }
catch (e) {
  console.error("SYNTAX FAIL: " + (e.stderr ? e.stderr.toString().slice(0, 500) : e.message));
  fs.unlinkSync("server.js.tmp.js");
  process.exit(1);
}
fs.renameSync("server.js.tmp.js", "server.js");
console.log("server.js patched OK");
ENDOFJS

cat /tmp/patch_out.txt

node --check server.js
echo "SECOND SYNTAX CHECK OK"

git add -A
git commit -m "fix(chat): reliable POST /chat/conversations - real inserts, rollback, dedup"
git push origin main
echo "DONE - pushed - Render redeploy in ~2 min"
