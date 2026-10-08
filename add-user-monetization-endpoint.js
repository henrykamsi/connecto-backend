const fs = require("fs");
const path = "server.js";

let srv = fs.readFileSync(path, "utf8");

if (srv.includes("[USER-MONETIZATION-ENDPOINT]")) {
  console.log("SKIP: endpoint already added");
  process.exit(0);
}

const anchor = 'app.use("/control-api", controlRouter);';
if (!srv.includes(anchor)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}

const block = `

/* [USER-MONETIZATION-ENDPOINT] Public view of a user's monetization config */
app.get("/api/v1/users/:id/monetization", async (req, res) => {
  try {
    const { query } = require("./src/db");
    const userId = req.params.id;
    if (!userId) return res.status(400).json({ success: false, error: "USER_ID_REQUIRED" });

    const stars = await query("SELECT price_ngn, button_label, enabled FROM stars_config WHERE user_id=$1 LIMIT 1", [userId]).catch(() => ({ rows: [] }));
    const adrev = await query("SELECT button_label, enabled FROM ad_revenue_config WHERE user_id=$1 LIMIT 1", [userId]).catch(() => ({ rows: [] }));

    const starsEnabled = stars.rows.length ? Number(stars.rows[0].enabled) === 1 : false;
    const adRevenueEnabled = adrev.rows.length ? Number(adrev.rows[0].enabled) === 1 : false;

    res.json({
      success: true,
      stars: {
        enabled: starsEnabled,
        price_ngn: starsEnabled ? Number(stars.rows[0].price_ngn || 1000) : null,
        button_label: starsEnabled ? (stars.rows[0].button_label || "Support us") : null
      },
      ad_revenue: {
        enabled: adRevenueEnabled,
        button_label: adRevenueEnabled ? (adrev.rows[0].button_label || "Support by watching an ad") : null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

`;

srv = srv.replace(anchor, anchor + block);
fs.writeFileSync(path, srv);
console.log("OK: user monetization endpoint added");
