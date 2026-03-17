// Run this from the linkedin-agent directory:  node src/diag.js
/******* THIS FILE MOVED AND MAY NOT WORK AS DESCRIBED - bindia 3/17/2026 ******/

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "../../.env");

console.log("=== DIAGNOSTIC: dotenv + decrypt-key ===\n");
console.log(`1. __dirname:  ${__dirname}`);
console.log(`2. .env path:  ${envPath}`);

// Check if file exists
import { existsSync, readFileSync } from "fs";
console.log(`3. .env exists: ${existsSync(envPath)}`);

if (existsSync(envPath)) {
  const raw = readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  console.log(`4. .env lines:  ${lines.length}`);
  console.log(`5. .env vars present:`);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx);
        const val = trimmed.substring(eqIdx + 1);
        console.log(`   ${key} = (${val.length} chars) first3="${val.substring(0, 3)}..." quoted=${val.startsWith('"') || val.startsWith("'")}`);
      }
    }
  }
}

console.log(`\n6. BEFORE dotenv.config():`);
console.log(`   ENCRYPTION_SECRET in env: ${process.env.ENCRYPTION_SECRET !== undefined} value="${process.env.ENCRYPTION_SECRET || ""}"`);
console.log(`   ENCRYPTION_SALT in env:   ${process.env.ENCRYPTION_SALT !== undefined} value="${process.env.ENCRYPTION_SALT || ""}"`);
console.log(`   ANTHROPIC_API_KEY_ENCRYPTED in env: ${process.env.ANTHROPIC_API_KEY_ENCRYPTED !== undefined}`);

const result = dotenv.config({ path: envPath });

console.log(`\n7. dotenv.config() result:`);
console.log(`   error:  ${result.error || "none"}`);
console.log(`   parsed: ${result.parsed ? Object.keys(result.parsed).join(", ") : "null"}`);

console.log(`\n8. AFTER dotenv.config():`);
console.log(`   ENCRYPTION_SECRET in env: ${process.env.ENCRYPTION_SECRET !== undefined} value="${(process.env.ENCRYPTION_SECRET || "").substring(0, 3)}..." (${(process.env.ENCRYPTION_SECRET || "").length} chars)`);
console.log(`   ENCRYPTION_SALT in env:   ${process.env.ENCRYPTION_SALT !== undefined} value="${(process.env.ENCRYPTION_SALT || "").substring(0, 3)}..." (${(process.env.ENCRYPTION_SALT || "").length} chars)`);
console.log(`   ANTHROPIC_API_KEY_ENCRYPTED in env: ${process.env.ANTHROPIC_API_KEY_ENCRYPTED !== undefined} (${(process.env.ANTHROPIC_API_KEY_ENCRYPTED || "").length} chars)`);

// Now try decryption
console.log(`\n9. Attempting decryptApiKey()...`);
try {
  const { decryptApiKey } = await import("../src/services/decrypt-key.js");
  const key = decryptApiKey();
  console.log(`   SUCCESS — decrypted key starts with: ${key.substring(0, 10)}...`);
} catch (err) {
  console.log(`   FAILED — ${err.message}`);
}
