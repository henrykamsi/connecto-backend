const crypto = require("crypto");

const SQUAD_BASE = process.env.SQUAD_ENV === "live"
  ? "https://api-d.squadco.com"
  : "https://sandbox-api-d.squadco.com";

async function getSquadCreds() {
  try {
    const { query } = require("../db");
    const r = await query(
      "SELECT * FROM provider_credentials WHERE category='payments' AND provider='squad' AND is_active=1 ORDER BY is_primary DESC, priority ASC LIMIT 1"
    );
    if (r.rows.length) {
      const row = r.rows[0];
      const KEY = process.env.CONTROL_ENCRYPTION_KEY;
      if (KEY) {
        const raw = Buffer.from(row.credentials_enc, "base64");
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const data = raw.subarray(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
        const cred = JSON.parse(decrypted.toString("utf8"));
        return {
          secretKey: cred.secretKey || cred.secret_key || "",
          publicKey: cred.publicKey || cred.public_key || "",
          webhookSecret: cred.webhookSecret || cred.webhook_secret || ""
        };
      }
    }
  } catch (e) {
    console.error("[SQUAD] panel read failed:", e.message);
  }
  return {
    secretKey: process.env.SQUAD_SECRET_KEY || "",
    publicKey: process.env.SQUAD_PUBLIC_KEY || "",
    webhookSecret: process.env.SQUAD_WEBHOOK_SECRET || ""
  };
}

async function initTransaction({ email, amountKobo, reference, callbackUrl }) {
  const creds = await getSquadCreds();
  if (!creds.secretKey) throw new Error("SQUAD_SECRET_KEY not configured");

  const body = {
    amount: amountKobo,
    email,
    currency: "NGN",
    initiate_type: "inline",
    transaction_ref: reference,
    callback_url: callbackUrl || "https://connecto.app/payment-return"
  };

  const resp = await fetch(SQUAD_BASE + "/transaction/initiate", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + creds.secretKey,
      "Content-Type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error("Squad init failed: " + JSON.stringify(data).slice(0, 200));
  }
  return data.data?.checkout_url || null;
}

async function getBanks() {
  const creds = await getSquadCreds();
  if (!creds.secretKey) throw new Error("SQUAD_SECRET_KEY not configured");

  const resp = await fetch(SQUAD_BASE + "/bank", {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + creds.secretKey,
      "accept": "application/json"
    }
  });

  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error("Squad banks failed: " + JSON.stringify(data).slice(0, 200));
  }
  return (data.data || []).map(b => ({ code: b.code, name: b.name }));
}

async function lookupAccount(bankCode, accountNumber) {
  const creds = await getSquadCreds();
  if (!creds.secretKey) throw new Error("SQUAD_SECRET_KEY not configured");

  const url = SQUAD_BASE + "/payout/account/lookup?bank_code=" + encodeURIComponent(bankCode) + "&account_number=" + encodeURIComponent(accountNumber);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + creds.secretKey,
      "accept": "application/json"
    }
  });

  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error("Squad lookup failed: " + JSON.stringify(data).slice(0, 200));
  }
  return { account_name: data.data?.account_name || data.data?.accountName || "" };
}

async function transfer({ bankCode, accountNumber, accountName, amountKobo, reference, narration }) {
  const creds = await getSquadCreds();
  if (!creds.secretKey) throw new Error("SQUAD_SECRET_KEY not configured");

  const body = {
    bank_code: bankCode,
    account_number: accountNumber,
    account_name: accountName,
    amount: amountKobo,
    currency_id: "NGN",
    transaction_reference: reference,
    remark: narration || "Connecto withdrawal"
  };

  const resp = await fetch(SQUAD_BASE + "/payout/transfer", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + creds.secretKey,
      "Content-Type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error("Squad transfer failed: " + JSON.stringify(data).slice(0, 200));
  }
  return data.data || {};
}

module.exports = { initTransaction, getBanks, lookupAccount, transfer, getSquadCreds };
