const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "control-server.js");

if (!fs.existsSync(target)) {
  console.error("ERROR: control-server.js not found at " + target);
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");

if (src.includes("[CONTROL] new schema ready")) {
  console.log("SKIP: schema block already inserted.");
  process.exit(0);
}

const anchor = "const router = express.Router();";

if (!src.includes(anchor)) {
  console.error("ERROR: anchor not found in control-server.js");
  process.exit(1);
}

const block = `/* ============================================================================
 * NEW SCHEMA - User actions, verification, broadcast, banned words, labels
 * ==========================================================================*/

(async () => {
  try {
    const { run } = require("./src/db");

    await run(\`CREATE TABLE IF NOT EXISTS user_blocks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      duration TEXT NOT NULL,
      reason TEXT,
      blocked_by TEXT,
      blocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id)\`);

    await run(\`CREATE TABLE IF NOT EXISTS user_suspensions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      duration TEXT NOT NULL,
      reason TEXT,
      suspended_by TEXT,
      suspended_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_user_suspensions_user ON user_suspensions(user_id)\`);

    await run(\`CREATE TABLE IF NOT EXISTS user_restrictions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restrictions TEXT NOT NULL,
      duration TEXT NOT NULL,
      restricted_by TEXT,
      restricted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_user_restrictions_user ON user_restrictions(user_id)\`);

    await run(\`CREATE TABLE IF NOT EXISTS verification_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      real_name TEXT,
      real_surname TEXT,
      age INTEGER,
      notes TEXT,
      domain TEXT,
      domain_method TEXT,
      domain_verified INTEGER NOT NULL DEFAULT 0,
      domain_token TEXT,
      category TEXT,
      social_links TEXT,
      passport_image TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_verification_requests_status ON verification_requests(status)\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_verification_requests_user ON verification_requests(user_id)\`);

    await run(\`CREATE TABLE IF NOT EXISTS pending_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_pending_verifications_user ON pending_verifications(user_id)\`);

    await run(\`CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_by TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )\`);

    await run(\`CREATE TABLE IF NOT EXISTS banned_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL UNIQUE,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )\`);

    await run(\`CREATE TABLE IF NOT EXISTS warning_labels (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      text TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT 'faded',
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )\`);
    await run(\`CREATE INDEX IF NOT EXISTS idx_warning_labels_post ON warning_labels(post_id)\`);

    console.log("[CONTROL] new schema ready");
  } catch (e) {
    console.error("[CONTROL] schema init:", e.message);
  }
})();

`;

src = src.replace(anchor, block + anchor);
fs.writeFileSync(target, src);
console.log("OK: schema block inserted above: " + anchor);
