#!/data/data/com.termux/files/usr/bin/bash
set -e
G='\033[32m'; R='\033[31m'; Y='\033[33m'; C='\033[36m'; X='\033[0m'
ok(){ echo -e "  ${G}✓${X} $1"; }
bad(){ echo -e "  ${R}✗${X} $1"; }
info(){ echo -e "${C}▸ $1${X}"; }

echo ""
echo "════════════════════════════════════════════════════"
echo "  DIAGNOSE → FIX → VERIFY → PUSH"
echo "════════════════════════════════════════════════════"

info "STEP 1 — is Render actually running the new commit?"
LIVE=$(curl -s --max-time 60 "https://connecto-backend-luxa.onrender.com/api/v1/health" || echo "DEAD")
if echo "$LIVE" | grep -q '"success":true'; then ok "Render is up"; else bad "Render: $LIVE"; fi
echo ""

info "STEP 2 — mint a fresh 30m token for a real user"
node -e "
require('dotenv').config();
const jwt=require('jsonwebtoken'),env=require('./src/config/env'),{query}=require('./src/db');
query(\"SELECT id,email FROM users WHERE account_status='active' AND deleted_at IS NULL LIMIT 1\").then(r=>{
  if(!r.rows.length){console.error('NO_ACTIVE_USER');process.exit(1);}
  const t=jwt.sign({sub:r.rows[0].id,type:'access'},env.jwt.secret,{expiresIn:'30m'});
  require('fs').writeFileSync('/tmp/token',t);
  console.log('  user='+r.rows[0].email);
  process.exit(0);
});"
ok "token minted"
TOKEN=$(cat /tmp/token)
echo ""

info "STEP 3 — hit the LIVE Render endpoint with that token"
HTTP=$(curl -s -o /tmp/feed_live.json -w "%{http_code}" --max-time 90 \
  -H "Authorization: Bearer $TOKEN" \
  "https://connecto-backend-luxa.onrender.com/api/v1/feed/smart?limit=3&offset=0" || echo "000")
echo "  HTTP $HTTP"
echo "  body[0:300]: $(head -c 300 /tmp/feed_live.json)"
echo ""
if [ "$HTTP" = "200" ]; then
  ok "Render feed WORKS — the problem is Android-side (timeout too short OR app cache OR APK stale)"
  echo ""
  echo "  → Your app is likely timing out at 30s (OkHttp default read timeout is 60s but FeedScreen has its own catch)"
  echo "  → Fix: increase OkHttp read timeout in ApiClient.kt from 60s to 180s, OR keep Turso faster"
elif [ "$HTTP" = "000" ]; then
  bad "TIMEOUT (>90s) — Turso is far too slow. Response never arrived. Root cause: DB region."
elif [ "$HTTP" = "500" ]; then
  bad "500 error — here is the exact server-side error:"
  echo "  $(cat /tmp/feed_live.json | head -c 500)"
  echo ""
  echo "  → Send this body to me. This is the actual bug."
elif [ "$HTTP" = "401" ]; then
  bad "401 — token rejected. Check JWT_SECRET in Render env matches your local .env"
else
  bad "HTTP $HTTP — unexpected"
  echo "  $(cat /tmp/feed_live.json | head -c 500)"
fi
echo ""

info "STEP 4 — try /health/db on Render to see if DB itself is slow"
DBH=$(curl -s -o /tmp/dbh.json -w "%{http_code} %{time_total}s" --max-time 90 \
  "https://connecto-backend-luxa.onrender.com/api/v1/health/db" || echo "000 0s")
echo "  /health/db → $DBH"
echo "  body: $(head -c 200 /tmp/dbh.json)"
echo ""

info "STEP 5 — check if Android is timing out"
echo "  Current OkHttp config in ApiClient.kt:"
grep -A2 "readTimeout" ~/connecto/../ApiClient.kt 2>/dev/null || \
  grep -rn "readTimeout" ~ 2>/dev/null | grep -i api | head -3 || \
  echo "  (not found locally — you'll need to check ApiClient.kt)"
echo ""

echo "════════════════════════════════════════════════════"
echo "  NOW PASTE THE OUTPUT ABOVE"
echo "════════════════════════════════════════════════════"
echo ""
