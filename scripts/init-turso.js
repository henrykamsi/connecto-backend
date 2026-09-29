require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { exec, healthCheck } = require("../src/db");

async function main() {
  console.log("Testing Turso connection...");

  const healthy = await healthCheck();

  if (!healthy) {
    throw new Error("Turso health check failed");
  }

  console.log("Turso connection: OK");

  const schemaPath =
    path.join(__dirname, "turso-schema.sql");

  const schema =
    fs.readFileSync(schemaPath, "utf8");

  console.log("Applying Connecto V1 schema...");

  await exec(schema);

  console.log("Connecto V1 Turso schema: READY");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("TURSO INITIALIZATION FAILED");
    console.error(error.message);
    process.exit(1);
  });
