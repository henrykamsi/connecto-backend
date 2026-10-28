const https = require("https");
const http = require("http");
const env = require("../config/env");

const url = env.turso.databaseUrl;
const authToken = env.turso.authToken;

if (!url) throw new Error("TURSO_DATABASE_URL is not configured");
if (!authToken) throw new Error("TURSO_AUTH_TOKEN is not configured");

// libsql://<host>  →  https://<host>
const tursoHost = (function () {
  try {
    return new URL(String(url).replace(/^libsql:\/\//, "https://")).hostname;
  } catch (e) {
    throw new Error("Invalid TURSO_DATABASE_URL: " + e.message);
  }
})();

// ---------------------------------------------------------------------------
// SQL normalizer (same as before — Turso = SQLite dialect)
// ---------------------------------------------------------------------------
function normalizeSql(sql) {
  return String(sql)
    .replace(/\bNOW\s*\(\s*\)/gi, "CURRENT_TIMESTAMP")
    .replace(/::text\b/gi, "")
    .replace(/::varchar\b/gi, "")
    .replace(/::uuid\b/gi, "")
    .replace(/::jsonb\b/gi, "");
}

// ---------------------------------------------------------------------------
// Translate our $1,$2,$3  →  Turso's positional :v1,:v2,:v3 + named args
// Turso's pipeline API uses named args. We build them from $N placeholders.
// ---------------------------------------------------------------------------
function translateArgs(sql, params) {
  const args = {};
  let out = sql.replace(/\$(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= params.length) {
      // leave it untouched — Turso will error, which we surface
      return "$" + n;
    }
    const key = "v" + n;
    let value = params[idx];
    if (value === undefined || value === null) {
      args[key] = { type: "null" };
    } else if (typeof value === "number") {
      args[key] = { type: Number.isInteger(value) ? "integer" : "float", value: String(value) };
    } else if (typeof value === "boolean") {
      args[key] = { type: "integer", value: value ? "1" : "0" };
    } else if (value instanceof Uint8Array) {
      args[key] = { type: "blob", base64: Buffer.from(value).toString("base64") };
    } else {
      args[key] = { type: "text", value: String(value) };
    }
    return ":" + key;
  });
  return { sql: out, args };
}

// ---------------------------------------------------------------------------
// Raw HTTPS POST to Turso /v2/pipeline
// ---------------------------------------------------------------------------
function tursoRequest(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: tursoHost,
      port: 443,
      path: "/v2/pipeline",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + authToken,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: timeoutMs || 30000
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("Turso HTTP " + res.statusCode + ": " + data.slice(0, 300)));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Turso non-JSON response: " + data.slice(0, 200))); }
      });
    });
    req.on("error", (e) => reject(new Error("Turso req error: " + (e.code || "") + " " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Turso timeout after " + (timeoutMs || 30000) + "ms")); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Convert Turso row format back into a plain JS object
// ---------------------------------------------------------------------------
function decodeCell(cell) {
  if (!cell || cell.type === "null") return null;
  switch (cell.type) {
    case "integer": return parseInt(cell.value, 10);
    case "float":   return parseFloat(cell.value);
    case "text":    return cell.value;
    case "blob":    return cell.base64;
    default:        return cell.value;
  }
}

function rowsFromResult(result) {
  if (!result || !result.response) return [];
  const resp = result.response;
  if (resp.type !== "execute") return [];
  const res = resp.result;
  if (!res) return [];
  const cols = (res.cols || []).map((c) => c.name);
  const rows = res.rows || [];
  return rows.map((r) => {
    const obj = {};
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = decodeCell(r[i]);
    }
    return obj;
  });
}

function rowsAffectedFrom(result) {
  if (!result || !result.response) return 0;
  const resp = result.response;
  if (resp.type !== "execute") return 0;
  const res = resp.result;
  return (res && typeof res.affected_row_count === "number") ? res.affected_row_count : 0;
}

// ---------------------------------------------------------------------------
// Serial mutex — Turso free tier doesn't like concurrent pipelines
// ---------------------------------------------------------------------------
let __chain = Promise.resolve();
function serialize(fn) {
  const next = __chain.then(fn, fn);
  __chain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Public API — matches the shape of the old library
// ---------------------------------------------------------------------------
async function query(sql, params = []) {
  const normalized = normalizeSql(sql).trim();
  const upper = normalized.replace(/^\s+/, "").toUpperCase();
  const isRead = upper.startsWith("SELECT") || upper.startsWith("WITH") || upper.startsWith("PRAGMA") || /\bRETURNING\b/i.test(normalized);

  const { sql: translated, args } = translateArgs(normalized, params);

  return serialize(async () => {
    const body = {
      requests: [
        { type: "execute", stmt: { sql: translated, named_args: args ? Object.entries(args).map(([k, v]) => ({ name: k, value: v })) : [] } },
        { type: "close" }
      ]
    };
    const parsed = await tursoRequest(body, 30000);
    const first = (parsed.results || [])[0];
    if (first && first.type === "error") {
      throw new Error("Turso SQL error: " + (first.error?.message || "unknown"));
    }
    const rows = rowsFromResult(first);
    const affected = rowsAffectedFrom(first);
    return { rows, rowCount: isRead ? rows.length : affected, rowsAffected: affected };
  });
}

async function get(sql, params = []) {
  const r = await query(sql, params);
  return r.rows[0] || null;
}

async function run(sql, params = []) {
  const normalized = normalizeSql(sql).trim();
  const { sql: translated, args } = translateArgs(normalized, params);
  return serialize(async () => {
    const body = {
      requests: [
        { type: "execute", stmt: { sql: translated, named_args: args ? Object.entries(args).map(([k, v]) => ({ name: k, value: v })) : [] } },
        { type: "close" }
      ]
    };
    const parsed = await tursoRequest(body, 30000);
    const first = (parsed.results || [])[0];
    if (first && first.type === "error") {
      throw new Error("Turso SQL error: " + (first.error?.message || "unknown"));
    }
    return { rowsAffected: rowsAffectedFrom(first) };
  });
}

async function exec(sql) {
  // Split multiple statements (Turso's batch needs an array)
  const stmts = String(sql).split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (!stmts.length) return { ok: true };
  return serialize(async () => {
    const body = {
      requests: stmts.map((s) => ({ type: "execute", stmt: { sql: normalizeSql(s) } })).concat([{ type: "close" }])
    };
    const parsed = await tursoRequest(body, 60000);
    for (const r of parsed.results || []) {
      if (r && r.type === "error") throw new Error("Turso exec error: " + (r.error?.message || "unknown"));
    }
    return { ok: true };
  });
}

async function batch(statements) {
  if (!Array.isArray(statements)) throw new Error("batch() needs an array");
  return serialize(async () => {
    const body = {
      requests: statements.map((s) => {
        const t = translateArgs(normalizeSql(s.sql || s), s.params || []);
        return { type: "execute", stmt: { sql: t.sql, named_args: Object.entries(t.args).map(([k, v]) => ({ name: k, value: v })) } };
      }).concat([{ type: "close" }])
    };
    return tursoRequest(body, 60000);
  });
}

async function healthCheck() {
  try {
    const row = await get("SELECT 1 AS ok");
    return Number(row?.ok) === 1;
  } catch (e) {
    console.error("[HEALTHCHECK]", e.message);
    return false;
  }
}

module.exports = { query, get, run, exec, batch, healthCheck };
