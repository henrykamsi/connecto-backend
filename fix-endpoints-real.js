const fs = require("fs");

// 1. Modify server.js to add /api/v1 aliases mounted at the top level
let srv = fs.readFileSync("server.js", "utf8");

if (srv.includes("[ANDROID-ALIASES]")) {
  console.log("SKIP: aliases already added.");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';

if (!srv.includes(anchor)) {
  console.error("ERROR: anchor 'app.use(\"/control-api\", controlRouter);' not found in server.js");
  process.exit(1);
}

const aliasRouter = `

/* [ANDROID-ALIASES] Android calls /api/v1/verification/* and /api/v1/me/bookmarks */
/* We expose them here at the top level so the app doesn't need changes.        */
const { query: _aliasQuery, run: _aliasRun } = require("./src/db");
const jwt = require("jsonwebtoken");
const env = require("./src/config/env");

async function androidAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
    const payload = jwt.verify(h.slice(7), env.jwt.secret);
    const r = await _aliasQuery("SELECT id, email, username, first_name, surname, is_verified, is_owner FROM users WHERE id=$1 LIMIT 1", [payload.sub]);
    if (!r.rows.length) return res.status(401).json({ success: false, error: "USER_NOT_FOUND" });
    req.admin = { id: r.rows[0].id, email: r.rows[0].email };
    req.user = { id: r.rows[0].id };
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: "INVALID_TOKEN" });
  }
}

const androidAliasRouter = require("express").Router();

androidAliasRouter.post("/verification/verify-domain", androidAuth, async (req, res) => {
  try {
    const domain = String(req.body.domain || "").trim().replace(/^https?:\\/\\//, "").replace(/\\/.*$/, "");
    const method = String(req.body.method || "meta");
    const token = String(req.body.token || "").trim();
    if (!domain || !token) return res.status(400).json({ success: false, error: "DOMAIN_AND_TOKEN_REQUIRED" });

    if (method === "meta") {
      try {
        const url = "https://" + domain;
        const resp = await fetch(url, { redirect: "follow", headers: { "User-Agent": "ConnectoVerify/1.0" } });
        const html = await resp.text();
        if (html.includes(token)) {
          await _aliasRun("UPDATE verification_requests SET domain=$1, domain_method=$2, domain_verified=1, domain_token=$3 WHERE user_id=$4 AND status='pending'", [domain, method, token, req.admin.id]);
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
          await _aliasRun("UPDATE verification_requests SET domain=$1, domain_method=$2, domain_verified=1, domain_token=$3 WHERE user_id=$4 AND status='pending'", [domain, method, token, req.admin.id]);
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

androidAliasRouter.post("/verification/submit", androidAuth, async (req, res) => {
  try {
    const { v4: uuidv4 } = require("uuid");
    const realName = String(req.body.realName || "").trim();
    const realSurname = String(req.body.realSurname || "").trim();
    const age = Number(req.body.age) || 0;
    const notes = String(req.body.notes || "").trim();
    const category = String(req.body.category || "").trim();
    const socialLinks = String(req.body.socialLinks || "").trim();

    if (!realName || !realSurname || !age || !socialLinks) return res.status(400).json({ success: false, error: "MISSING_REQUIRED_FIELDS" });
    if (age < 18) return res.status(400).json({ success: false, error: "MUST_BE_18_OR_OLDER" });

    let existing = await _aliasQuery("SELECT id FROM verification_requests WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    let requestId;
    if (existing.rows.length) {
      requestId = existing.rows[0].id;
    } else {
      requestId = uuidv4();
      await _aliasRun("INSERT INTO verification_requests (id, user_id, status) VALUES ($1,$2,'pending')", [requestId, req.admin.id]);
    }

    const idPhotoBase64 = String(req.body.idPhotoBase64 || "").trim();
    const idPhotoMime = String(req.body.idPhotoMime || "image/jpeg").trim();

    await _aliasRun(
      "UPDATE verification_requests SET real_name=$1, real_surname=$2, age=$3, notes=$4, category=$5, social_links=$6, status='pending', passport_image=$7 WHERE id=$8",
      [realName, realSurname, age, notes, category, socialLinks, idPhotoBase64 ? (idPhotoMime + "|" + idPhotoBase64) : null, requestId]
    );

    res.json({ success: true, requestId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

androidAliasRouter.get("/me/bookmarks", androidAuth, async (req, res) => {
  try {
    const r = await _aliasQuery(
      "SELECT p.id, p.text, p.author_id, p.created_at, u.first_name, u.surname, u.username, u.is_verified AS author_verified FROM bookmarks b JOIN posts p ON p.id = b.post_id JOIN users u ON u.id = p.author_id WHERE b.user_id=$1 AND p.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 100",
      [req.admin.id]
    );
    res.json({ success: true, posts: r.rows });
  } catch (err) {
    res.json({ success: true, posts: [] });
  }
});

androidAliasRouter.get("/pending-verification", androidAuth, async (req, res) => {
  try {
    const r = await _aliasQuery("SELECT id, message FROM pending_verifications WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [req.admin.id]);
    if (!r.rows.length) return res.json({ success: true, pending: false });
    res.json({ success: true, pending: true, id: r.rows[0].id, message: r.rows[0].message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

androidAliasRouter.post("/pending-verification/:id/accept", androidAuth, async (req, res) => {
  try {
    await _aliasRun("UPDATE pending_verifications SET status='accepted' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    await _aliasRun("UPDATE users SET is_verified=1, verified_label='Verified Account', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

androidAliasRouter.post("/pending-verification/:id/decline", androidAuth, async (req, res) => {
  try {
    await _aliasRun("UPDATE pending_verifications SET status='declined' WHERE id=$1 AND user_id=$2", [req.params.id, req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use("/api/v1", androidAliasRouter);

`;

srv = srv.replace(anchor, anchor + aliasRouter);
fs.writeFileSync("server.js", srv);
console.log("OK: android aliases added to server.js");
