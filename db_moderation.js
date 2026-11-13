const fs = require("fs");
const { execSync } = require("child_process");

const dbPath = "src/db/index.js";
let dbSrc = fs.readFileSync(dbPath, "utf8");

// We will wrap the `run` function in the database file
const runAnchor = /async function run\(sql, params = \[\]\) \{/;

if (!dbSrc.includes("/* [DB-LABEL-INTERCEPTOR] */")) {
    const interceptor = `
/* [DB-LABEL-INTERCEPTOR] */
async function __moderatePost(sql, params) {
  try {
    // If we are inserting a post, check if it has text
    if (/INSERT INTO posts/i.test(sql) && params.length >= 3) {
      const text = String(params[2] || "").trim();
      if (text.length > 2) {
        const keys = (process.env.OPENAI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
        if (keys.length > 0) {
          const payload = JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "text", text }] });
          for (const key of keys) {
            const r = await fetch("https://api.openai.com/v1/moderations", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
              body: payload
            });
            if (r.ok) {
              const data = await r.json();
              const cats = data.results[0].categories || {};
              let label = null;
              if (cats["sexual"] || cats["sexual/minors"]) label = "NUDITY CONTENT (18+)";
              else if (cats["violence"] || cats["violence/graphic"]) label = "OBJECTS IN THIS VIDEO MIGHT BE HARMFUL";
              else if (cats["self-harm"]) label = "DO NOT TRY THIS";
              else if (cats["harassment"] || cats["hate"]) label = "INAPPROPRIATE CONTENT";
              
              if (label) {
                console.log("[DB-MOD] Caught bad post! Label:", label);
                // We dynamically add the warning label to the INSERT parameters!
                // We need to know the exact schema, so let's just do a quick update after it inserts.
                // We'll return the label so the run() can use it.
                return label; 
              }
              break;
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("[DB-MOD-ERROR]", e.message);
  }
  return null;
}
`;
    dbSrc = dbSrc.replace(runAnchor, interceptor + "\n\nasync function run(sql, params = []) {");
    
    // Now we need to actually execute the update. We'll modify the `run` function to call `__moderatePost` first.
    const runBodyAnchor = /async function run\(sql, params = \[\]\) \{/;
    
    // This is safe because we just injected the interceptor right above it.
    dbSrc = dbSrc.replace(
      "async function run(sql, params = []) {", 
      `async function run(sql, params = []) {
  const isPostInsert = /INSERT INTO posts/i.test(sql);
  let detectedLabel = null;
  if (isPostInsert) {
    detectedLabel = await __moderatePost(sql, params);
  }
`
    );
    
    // Now we need to find where the run function returns, so we can inject the update
    const returnAnchor = /return __serialize\(\(\) => __withTimeout\(db\.run\(normalizeSql\(sql\), params\), 20000, "run"\)\);/;
    
    if (dbSrc.match(returnAnchor)) {
      dbSrc = dbSrc.replace(returnAnchor, `
  return __serialize(async () => {
    const result = await __withTimeout(db.run(normalizeSql(sql), params), 20000, "run");
    
    // If we detected a label, update the row immediately
    if (detectedLabel && isPostInsert) {
      try {
        // We need the post ID. For standard inserts, params[0] is the ID.
        const postId = params[0];
        if (postId) {
          await __withTimeout(db.run("UPDATE posts SET warning_label=?, warning_label_style='danger' WHERE id=?", [detectedLabel, postId]), 10000, "mod-update");
          console.log("[DB-MOD] Successfully updated post", postId, "with label:", detectedLabel);
        }
      } catch (e) {
        console.error("[DB-MOD-UPDATE-ERROR]", e.message);
      }
    }
    
    return {
      rows: [],
      rowCount: typeof result?.rowsAffected === "number" ? result.rowsAffected : 0,
      rowsAffected: typeof result?.rowsAffected === "number" ? result.rowsAffected : 0
    };
  });`);
    } else {
      console.error("[SYNTAX FAIL] Could not find return anchor inside run function.");
      process.exit(1);
    }

    fs.writeFileSync(dbPath, dbSrc);
    console.log("[1] Patched src/db/index.js to intercept and label inserts.");
}

try {
  execSync("node --check src/db/index.js", { stdio: "pipe" });
  console.log("[OK] Syntax valid");
} catch (e) {
  console.error("[SYNTAX FAIL]", e.message);
  process.exit(1);
}
