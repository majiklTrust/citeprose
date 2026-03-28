// ═══════════════════════════════════════════════════════════════
// Extract OAuth state from a LinkedIn redirect URL
// ═══════════════════════════════════════════════════════════════
//
// Usage:
//   node extract-state.mjs "PASTE_FULL_LINKEDIN_URL_HERE"
//   ex. node ../build/extract-state.mjs "https://www.linkedin.com/uas/login?session_redirect=..."
//
// Or pipe it:
//   echo "https://www.linkedin.com/uas/login?session_redirect=..." | node scripts/extract-state.mjs
//

const input = process.argv[2] || await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => data += chunk);
  process.stdin.on("end", () => resolve(data.trim()));
  setTimeout(() => { if (!data) { console.error("Usage: node scripts/extract-state.mjs \"LINKEDIN_URL\""); process.exit(1); } }, 2000);
});

try {
  // Decode the full URL first
  let decoded = decodeURIComponent(input);

  // LinkedIn double-encodes — keep decoding until stable
  let prev = "";
  while (decoded !== prev) {
    prev = decoded;
    try { decoded = decodeURIComponent(decoded); } catch { break; }
  }

  // Extract state from the flow JSON
  const stateMatch = decoded.match(/"state"\s*:\s*"([0-9a-f]+)"/);

  // Also check for a top-level state= query param
  const paramMatch = input.match(/[?&]state=([0-9a-f]+)/);

  const state = stateMatch?.[1] || paramMatch?.[1];

  if (!state) {
    console.error("Could not find an OAuth state value in the URL.");
    console.error("");
    console.error("Decoded URL (first 500 chars):");
    console.error(decoded.substring(0, 500));
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════");
  console.log("  OAuth State Extracted");
  console.log("═══════════════════════════════════════════");
  console.log("");
  console.log(`  State:       ${state}`);
  console.log(`  Length:      ${state.length} chars`);
  console.log(`  Is 64 hex:   ${/^[0-9a-f]{64}$/.test(state)}`);
  console.log(`  Source:      ${stateMatch ? "flow JSON" : "query param"}`);
  console.log("");

  if (/^[0-9a-f]{64}$/.test(state)) {
    console.log("  ✓ Cryptographic — 32 bytes (crypto.randomBytes)");
  } else if (state.length < 30) {
    console.log("  ✗ Weak — likely Math.random() (too short)");
  } else {
    console.log("  ? Unrecognized format — verify manually");
  }

  console.log("");
  console.log("  To test single-use rejection, paste this into your browser");
  console.log("  AFTER completing the auth flow:");
  console.log("");
  console.log(`  http://localhost:3001/auth/linkedin/callback?code=test&state=${state}`);
  console.log("");
  console.log("  Expected: HTTP 403 — state already consumed");

} catch (err) {
  console.error("Error parsing URL:", err.message);
  process.exit(1);
}
