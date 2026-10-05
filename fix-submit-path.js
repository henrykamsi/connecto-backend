const fs = require("fs");
const path = "control-server.js";

if (!fs.existsSync(path)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(path, "utf8");

if (src.includes("[FIX-SUBMIT-PATH]")) {
  console.log("SKIP: submit alias already present.");
  process.exit(0);
}

const anchor = 'console.log("[CONTROL-SERVER] loaded " + (router.stack.filter(l=>l.route).length) + " routes");';

if (!src.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `/* [FIX-SUBMIT-PATH] Aliases so Android's /api/v1/* calls hit /control-api/* handlers */
router.post("/api/v1/verification/submit", controlAuth, async (req, res) => {
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

    const idPhotoBase64 = String(req.body.idPhotoBase64 || "").trim();
    const idPhotoMime = String(req.body.idPhotoMime || "image/jpeg").trim();

    await run(
      "UPDATE verification_requests SET real_name=$1, real_surname=$2, age=$3, notes=$4, category=$5, social_links=$6, status='pending', passport_image=$7 WHERE id=$8",
      [realName, realSurname, age, notes, category, socialLinks,
       idPhotoBase64 ? (idPhotoMime + "|" + idPhotoBase64) : null,
       requestId]
    );

    res.json({ success: true, requestId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/api/v1/verification/verify-domain", controlAuth, async (req, res) => {
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

router.get("/api/v1/me/bookmarks", controlAuth, async (req, res) => {
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

router.get("/api/v1/pending-verification", controlAuth, async (req, res) => {
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

router.post("/api/v1/pending-verification/:id/accept", controlAuth, async (req, res) => {
  try {
    await run("UPDATE pending_verifications SET status='accepted' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    await run("UPDATE users SET is_verified=1, verified_label='Verified Account', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/api/v1/pending-verification/:id/decline", controlAuth, async (req, res) => {
  try {
    await run("UPDATE pending_verifications SET status='declined' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

`;

src = src.replace(anchor, block + anchor);
fs.writeFileSync(path, src);
console.log("OK: /api/v1/* aliases added");
