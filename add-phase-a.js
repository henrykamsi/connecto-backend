const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "control-server.js");

if (!fs.existsSync(target)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");

if (src.includes("[PHASE-A] verification endpoints ready")) {
  console.log("SKIP: phase A already present.");
  process.exit(0);
}

const anchor = 'console.log("[CONTROL-SERVER] loaded " + (router.stack.filter(l=>l.route).length) + " routes");';

if (!src.includes(anchor)) {
  console.error("ERROR: anchor not found");
  console.error("Looking for: " + anchor);
  process.exit(1);
}

const block = `/* ============================================================================
 * PHASE A - Verification endpoints, bookmarks
 * ==========================================================================*/

router.get("/me/bookmarks", controlAuth, async (req, res) => {
  try {
    const r = await query(
      "SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, u.is_verified AS author_verified FROM bookmarks b JOIN posts p ON p.id = b.post_id JOIN users u ON u.id = p.author_id WHERE b.user_id=$1 AND p.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 100",
      [req.admin.id]
    );
    res.json({ success: true, posts: r.rows });
  } catch (err) {
    res.json({ success: true, posts: [] });
  }
});

router.post("/verification/start", controlAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const existing = await query("SELECT id FROM verification_requests WHERE user_id=$1 AND status='pending' LIMIT 1", [req.admin.id]);
    if (existing.rows.length) {
      return res.json({ success: true, alreadyPending: true, requestId: existing.rows[0].id });
    }
    const id = uuidv4();
    await run("INSERT INTO verification_requests (id, user_id, status) VALUES ($1,$2,'pending')", [id, req.admin.id]);
    res.json({ success: true, requestId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/verification/verify-domain", controlAuth, async (req, res) => {
  try {
    const domain = String(req.body.domain || "").trim().replace(/^https?:\\/\\//, "").replace(/\\/.*$/, "");
    const method = String(req.body.method || "meta");
    const token = String(req.body.token || "").trim();
    if (!domain || !token) {
      return res.status(400).json({ success: false, error: "DOMAIN_AND_TOKEN_REQUIRED" });
    }

    if (method === "meta") {
      try {
        const url = "https://" + domain;
        const resp = await fetch(url, { redirect: "follow", headers: { "User-Agent": "ConnectoVerify/1.0" } });
        const html = await resp.text();
        if (html.includes(token)) {
          await run("UPDATE verification_requests SET domain=$1, domain_method=$2, domain_verified=1, domain_token=$3 WHERE user_id=$4 AND status='pending'", [domain, method, token, req.admin.id]);
          return res.json({ success: true, verified: true });
        }
        return res.json({ success: true, verified: false, reason: "META_TAG_NOT_FOUND" });
      } catch (e) {
        return res.json({ success: true, verified: false, reason: "FETCH_FAILED", details: e.message });
      }
    }

    if (method === "dns") {
      try {
        const dns = require("dns").promises;
        const records = await dns.resolveTxt(domain);
        const flat = records.map(r => r.join("")).join(" ");
        if (flat.includes(token)) {
          await run("UPDATE verification_requests SET domain=$1, domain_method=$2, domain_verified=1, domain_token=$3 WHERE user_id=$4 AND status='pending'", [domain, method, token, req.admin.id]);
          return res.json({ success: true, verified: true });
        }
        return res.json({ success: true, verified: false, reason: "DNS_RECORD_NOT_FOUND" });
      } catch (e) {
        return res.json({ success: true, verified: false, reason: "DNS_LOOKUP_FAILED", details: e.message });
      }
    }

    res.status(400).json({ success: false, error: "INVALID_METHOD" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/verification/submit", controlAuth, async (req, res) => {
  try {
    const realName = String(req.body.realName || "").trim();
    const realSurname = String(req.body.realSurname || "").trim();
    const age = Number(req.body.age) || 0;
    const notes = String(req.body.notes || "").trim();
    const category = String(req.body.category || "").trim();
    const socialLinks = String(req.body.socialLinks || "").trim();

    if (!realName || !realSurname || !age || !socialLinks) {
      return res.status(400).json({ success: false, error: "MISSING_REQUIRED_FIELDS" });
    }
    if (age < 18) {
      return res.status(400).json({ success: false, error: "MUST_BE_18_OR_OLDER" });
    }

    const existing = await query("SELECT id FROM verification_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!existing.rows.length) {
      return res.status(400).json({ success: false, error: "NO_PENDING_REQUEST" });
    }
    const requestId = existing.rows[0].id;

    await run(
      "UPDATE verification_requests SET real_name=$1, real_surname=$2, age=$3, notes=$4, category=$5, social_links=$6, status='pending' WHERE id=$7",
      [realName, realSurname, age, notes, category, socialLinks, requestId]
    );

    res.json({ success: true, requestId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/verification/status", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, status, real_name, real_surname, category, created_at, reviewed_at FROM verification_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!r.rows.length) {
      return res.json({ success: true, status: "none" });
    }
    res.json({ success: true, status: r.rows[0].status, request: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/pending-verification", controlAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, message FROM pending_verifications WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!r.rows.length) {
      return res.json({ success: true, pending: false });
    }
    res.json({ success: true, pending: true, id: r.rows[0].id, message: r.rows[0].message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/pending-verification/:id/accept", controlAuth, async (req, res) => {
  try {
    await run("UPDATE pending_verifications SET status='accepted' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    await run("UPDATE users SET is_verified=1, verified_label='Verified Account', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/pending-verification/:id/decline", controlAuth, async (req, res) => {
  try {
    await run("UPDATE pending_verifications SET status='declined' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

console.log("[PHASE-A] verification endpoints ready");

`;

src = src.replace(anchor, block + anchor);
fs.writeFileSync(target, src);
console.log("OK: phase A endpoints inserted");
