const fs = require("fs");
const path = "server.js";

let src = fs.readFileSync(path, "utf8");

// Find the exact syntax error block
const brokenBlock = `    res.json({ success: true, mode, users, videos, music });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
}`;

const fixedBlock = `    res.json({ success: true, mode, users, videos, music });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});`;

if (src.includes(brokenBlock)) {
    src = src.replace(brokenBlock, fixedBlock);
    fs.writeFileSync(path, src);
    console.log("OK: Removed the stray closing bracket.");
} else {
    // Fallback: If the exact string doesn't match, try a generic repair
    console.log("Exact block not found. Attempting generic repair...");
    
    // Look for the error around line 5211
    const lines = src.split("\n");
    // Check if line 5210 (index 5209) is a stray closing brace
    if (lines[5209] && lines[5209].trim() === "}") {
        lines.splice(5209, 1);
        fs.writeFileSync(path, lines.join("\n"));
        console.log("OK: Removed stray bracket at line 5210.");
    } else {
        console.error("ERROR: Could not find the stray bracket. Please send me lines 5205 to 5215.");
        process.exit(1);
    }
}
