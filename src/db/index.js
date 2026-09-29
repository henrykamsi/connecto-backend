const { connect } = require("@tursodatabase/serverless");
const env = require("../config/env");

const url = env.turso.databaseUrl;
const authToken = env.turso.authToken;

if (!url) {
  throw new Error("TURSO_DATABASE_URL is not configured");
}

if (!authToken) {
  throw new Error("TURSO_AUTH_TOKEN is not configured");
}

const db = connect({
  url,
  authToken
});

/*
 * Convert the small number of PostgreSQL-specific expressions
 * used by the existing Connecto V1 code into SQLite/libSQL syntax.
 */
function normalizeSql(sql) {
  return String(sql)
    .replace(/\bNOW\s*\(\s*\)/gi, "CURRENT_TIMESTAMP")
    .replace(/::text\b/gi, "")
    .replace(/::varchar\b/gi, "")
    .replace(/::uuid\b/gi, "")
    .replace(/::jsonb\b/gi, "");
}

/*
 * Existing Connecto routes were originally written against pg.
 *
 * They expect:
 *
 * {
 *   rows: [...],
 *   rowCount: number
 * }
 *
 * This adapter keeps that interface while Turso/libSQL
 * handles the actual database operations.
 */
async function query(sql, params = []) {
  const normalized = normalizeSql(sql).trim();

  const upper = normalized.toUpperCase();

  const returnsRows =
    upper.startsWith("SELECT") ||
    upper.startsWith("WITH") ||
    upper.startsWith("PRAGMA") ||
    /\bRETURNING\b/i.test(normalized);

  if (returnsRows) {
    const rows = await db.all(normalized, params);

    return {
      rows: Array.isArray(rows) ? rows : [],
      rowCount: Array.isArray(rows) ? rows.length : 0
    };
  }

  const result = await db.run(normalized, params);

  return {
    rows: [],
    rowCount:
      typeof result?.rowsAffected === "number"
        ? result.rowsAffected
        : 0,
    rowsAffected:
      typeof result?.rowsAffected === "number"
        ? result.rowsAffected
        : 0
  };
}

async function get(sql, params = []) {
  return db.get(normalizeSql(sql), params);
}

async function run(sql, params = []) {
  return db.run(normalizeSql(sql), params);
}

async function exec(sql) {
  return db.exec(sql);
}

async function batch(statements) {
  return db.batch(statements);
}

async function healthCheck() {
  const row = await db.get("SELECT 1 AS ok");
  return Number(row?.ok) === 1;
}

module.exports = {
  db,
  query,
  get,
  run,
  exec,
  batch,
  healthCheck
};
