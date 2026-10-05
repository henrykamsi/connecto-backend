const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "control-server.js");

if (!fs.existsSync(target)) {
  console.error("ERROR: control-server.js not found");
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");

if (src.includes("[PHASE-E] blocked/suspended checks")) {
  console.log("SKIP: phase E already present.");
  process.exit(0);
}

// Patch the control-api login endpoint to check blocked/suspended after password check
// The control-api login is for the panel admins, so instead we patch the user-facing
// login in complete-v1.js — but complete-v1.js is a different file. We patch the main
// server.js instead via a helper.

// Actually, we add a middleware-style endpoint in control-server.js that the main
// /api/v1/auth/login can call. Simpler approach: patch complete-v1.js.

const completeTarget = path.join(__dirname, "src", "routes", "complete-v1.js");

if (!fs.existsSync(completeTarget)) {
  console.error("ERROR: src/routes/complete-v1.js not found");
  process.exit(1);
}

let cv = fs.readFileSync(completeTarget, "utf8");

if (cv.includes("[PHASE-E] blocked/suspended checks")) {
  console.log("SKIP: phase E already present in complete-v1.js.");
  process.exit(0);
}

const oldLogin = `router.post('/auth/login',async(req,res,next)=>{
  try {
    const identifier = String(
      req.body.identifier ||
      req.body.email ||
      req.body.username ||
      req.body.mobile ||
      ''
    ).trim();

    const result = await query(
      \`SELECT * FROM users
       WHERE lower(email)=lower($1)
          OR lower(username)=lower($1)
          OR mobile=$1
       LIMIT 1\`,
      [identifier]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      req.body.password || '',
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }
`;

const newLogin = `router.post('/auth/login',async(req,res,next)=>{
  try {
    const identifier = String(
      req.body.identifier ||
      req.body.email ||
      req.body.username ||
      req.body.mobile ||
      ''
    ).trim();

    const result = await query(
      \`SELECT * FROM users
       WHERE lower(email)=lower($1)
          OR lower(username)=lower($1)
          OR mobile=$1
       LIMIT 1\`,
      [identifier]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      req.body.password || '',
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    /* [PHASE-E] blocked/suspended checks */
    try {
      const blockCheck = await query(
        \`SELECT reason, expires_at FROM user_blocks
         WHERE user_id=$1
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY blocked_at DESC LIMIT 1\`,
        [user.id]
      );
      if (blockCheck.rows.length) {
        return res.status(403).json({
          success: false,
          blocked: true,
          reason: blockCheck.rows[0].reason || "",
          expires_at: blockCheck.rows[0].expires_at || null,
          error: "ACCOUNT_BLOCKED"
        });
      }

      const suspendCheck = await query(
        \`SELECT reason, expires_at FROM user_suspensions
         WHERE user_id=$1
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY suspended_at DESC LIMIT 1\`,
        [user.id]
      );
      if (suspendCheck.rows.length) {
        return res.status(403).json({
          success: false,
          suspended: true,
          reason: suspendCheck.rows[0].reason || "",
          expires_at: suspendCheck.rows[0].expires_at || null,
          error: "ACCOUNT_SUSPENDED"
        });
      }
    } catch (checkErr) {
      console.error("[PHASE-E] login check failed:", checkErr.message);
    }
`;

if (!cv.includes(oldLogin)) {
  console.error("ERROR: could not find login block in complete-v1.js");
  console.error("Looking for the block that starts with:");
  console.error("  router.post('/auth/login',async(req,res,next)=>{");
  const idx = cv.indexOf("router.post('/auth/login'");
  if (idx !== -1) {
    console.log("Context (500 chars):");
    console.log(cv.slice(idx, idx + 500));
  }
  process.exit(1);
}

cv = cv.replace(oldLogin, newLogin);
fs.writeFileSync(completeTarget, cv);

// Also patch the /api/v1/auth/me response to include is_verified
const oldMe = `router.get('/auth/me',auth,(req,res)=>{
  res.json({
    success:true,
    user:req.user
  });
});`;

const newMe = `router.get('/auth/me',auth,async(req,res)=>{
  try {
    const r = await query(
      \`SELECT id, name, surname, email, username, first_name,
              bio, category, country, state, gender,
              profile_photo_media_id, cover_photo_media_id,
              is_verified, is_owner, email_verified
       FROM users WHERE id=$1 LIMIT 1\`,
      [req.user.id]
    );
    if (!r.rows.length) {
      return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    }
    res.json({
      success: true,
      user: r.rows[0]
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});`;

if (cv.includes(oldMe)) {
  cv = cv.replace(oldMe, newMe);
  fs.writeFileSync(completeTarget, cv);
  console.log("OK: /auth/me patched to include is_verified");
}

console.log("OK: phase E login gating inserted into complete-v1.js");
