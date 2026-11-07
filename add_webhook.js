const fs = require('fs');
let src = fs.readFileSync('server.js', 'utf8');

if (src.includes('[AGORA-WEBHOOK]')) {
  console.log('Webhook already exists. Skipping.');
  process.exit(0);
}

const anchor = 'app.use("/api/v1", v1);';
if (!src.includes(anchor)) {
  console.error('Anchor not found in server.js');
  process.exit(1);
}

const webhookCode = `
/* [AGORA-WEBHOOK] */
const crypto = require('crypto');

app.post("/api/v1/calls/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['agora-signature-v2'] || req.headers['agora-signature'];
    const secret = process.env.AGORA_WEBHOOK_SECRET;
    
    if (!signature || !secret) {
      console.error("[WEBHOOK] Missing signature or secret");
      return res.status(401).send("Unauthorized");
    }

    const rawBody = req.body;
    const computedSignature = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    
    if (computedSignature !== signature) {
      console.error("[WEBHOOK] Signature mismatch");
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    
    if (payload.eventType === 108) {
      const { channelName, uid, reason, ts } = payload.payload;
      
      let reasonText = "Unknown";
      switch (reason) {
        case 1: reasonText = "User hung up normally"; break;
        case 2: reasonText = "Network timeout (no data for 10s)"; break;
        case 4: reasonText = "Server connection lost (reconnecting)"; break;
        case 10: reasonText = "Network connection issue (SDK disconnected)"; break;
        default: reasonText = "Reason code: " + reason;
      }

      console.log(\`[CALL-ENDED] Channel: \${channelName} | User: \${uid} | Time: \${new Date(ts * 1000).toISOString()} | Reason: \${reasonText}\`);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err.message);
    res.status(500).send("Internal Server Error");
  }
});
/* [/AGORA-WEBHOOK] */

`;

src = src.replace(anchor, webhookCode + anchor);
fs.writeFileSync('server.js', src);
console.log('Webhook inserted successfully.');
