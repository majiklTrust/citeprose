// ═══════════════════════════════════════════════════════════════
/******* THIS FILE MOVED AND MAY NOT WORK AS DESCRIBED - bindia 3/17/2026 ******/
// verify-key.js — Isolate decryption failures
//
// Usage: node scripts/verify-key.js
//
// Tests three things:
//   Test A: Decrypt using values from .env (as dotenv loads them)
//   Test B: Decrypt using values you type interactively
//   Test C: Encrypt then decrypt a test string to verify crypto works
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "path";
import readline from "node:readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");

const ITERATIONS = 200_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

// ── Helpers ──────────────────────────────────────────────────

function decrypt(encryptedKey, secret, salt) {
  const [ivHex, authTagHex, ciphertextHex] = encryptedKey.split(":");
  const saltBuf = Buffer.from(salt);
  const derivedKey = crypto.pbkdf2Sync(secret, saltBuf, ITERATIONS, KEY_LENGTH, DIGEST);
  const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return decipher.update(Buffer.from(ciphertextHex, "hex"), undefined, "utf8") + decipher.final("utf8");
}

function encrypt(plaintext, secret, salt) {
  const saltBuf = Buffer.from(salt);
  const derivedKey = crypto.pbkdf2Sync(secret, saltBuf, ITERATIONS, KEY_LENGTH, DIGEST);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

function showBytes(label, str) {
  const buf = Buffer.from(str, "utf8");
  const hex = buf.toString("hex");
  const printable = [...str].map(c => {
    const code = c.charCodeAt(0);
    if (code >= 32 && code <= 126) return c;
    return `\\x${code.toString(16).padStart(2, "0")}`;
  }).join("");
  console.log(`  ${label}:`);
  console.log(`    length:    ${str.length} chars, ${buf.length} bytes`);
  console.log(`    printable: "${printable}"`);
  console.log(`    hex:       ${hex.substring(0, 80)}${hex.length > 80 ? "..." : ""}`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  Key Decryption Verification Tool");
  console.log("═══════════════════════════════════════════════\n");

  // Load .env
  const envResult = dotenv.config({ path: envPath });
  if (envResult.error) {
    console.log(`[WARN] Could not load .env: ${envResult.error.message}\n`);
  } else {
    console.log(`[OK] Loaded .env from ${envPath}\n`);
  }

  const envEncrypted = process.env.ANTHROPIC_API_KEY_ENCRYPTED || "";
  const envSecret = process.env.ENCRYPTION_SECRET || "";
  const envSalt = process.env.ENCRYPTION_SALT || "";

  // ── Show what .env contains (byte-level) ───────────────────

  console.log("── Values loaded from .env ──────────────────────\n");
  showBytes("ANTHROPIC_API_KEY_ENCRYPTED", envEncrypted);
  console.log(`    colons:    ${(envEncrypted.match(/:/g) || []).length} (expected: 2)`);
  const parts = envEncrypted.split(":");
  if (parts.length === 3) {
    console.log(`    iv:        ${parts[0].length} hex chars (expected: 32)`);
    console.log(`    authTag:   ${parts[1].length} hex chars (expected: 32)`);
    console.log(`    cipher:    ${parts[2].length} hex chars`);
  }
  console.log("");
  showBytes("ENCRYPTION_SECRET", envSecret);
  console.log("");
  showBytes("ENCRYPTION_SALT", envSalt);

  // ── Test A: .env values ────────────────────────────────────

  console.log("\n── TEST A: Decrypt using .env values ───────────\n");

  if (!envEncrypted || !envSecret || !envSalt) {
    console.log("  SKIPPED — one or more .env values are empty.\n");
  } else {
    try {
      const result = decrypt(envEncrypted, envSecret, envSalt);
      console.log(`  SUCCESS — decrypted key starts with: ${result.substring(0, 12)}...`);
      console.log(`  Key length: ${result.length} chars\n`);
    } catch (err) {
      console.log(`  FAILED — ${err.message}\n`);
    }
  }

  // ── Test B: Interactive values ─────────────────────────────

  console.log("── TEST B: Decrypt using typed values ──────────\n");
  console.log("  Type the EXACT passphrase and salt you used during encryption.");
  console.log("  (Input is visible so you can verify what you're typing.)\n");

  const typedSecret = await ask("  Passphrase: ");
  const typedSalt = await ask("  Salt:       ");

  console.log("");
  showBytes("Typed passphrase", typedSecret);
  console.log("");
  showBytes("Typed salt", typedSalt);

  // Compare with .env
  console.log("\n  Comparison with .env values:");
  console.log(`    Passphrase matches .env: ${typedSecret === envSecret}${typedSecret !== envSecret ? ` (env=${envSecret.length} chars, typed=${typedSecret.length} chars)` : ""}`);
  console.log(`    Salt matches .env:       ${typedSalt === envSalt}${typedSalt !== envSalt ? ` (env=${envSalt.length} chars, typed=${typedSalt.length} chars)` : ""}`);

  if (envEncrypted) {
    console.log("\n  Attempting decryption with typed values...");
    try {
      const result = decrypt(envEncrypted, typedSecret, typedSalt);
      console.log(`  SUCCESS — decrypted key starts with: ${result.substring(0, 12)}...`);
      console.log(`  Key length: ${result.length} chars\n`);
    } catch (err) {
      console.log(`  FAILED — ${err.message}\n`);
    }
  }

  // ── Test C: Round-trip ─────────────────────────────────────

  console.log("── TEST C: Fresh encrypt → decrypt round-trip ──\n");

  const testPlaintext = "sk-ant-test-1234567890";
  const testSecret = typedSecret || "test-passphrase";
  const testSalt = typedSalt || "test-salt";

  try {
    const encrypted = encrypt(testPlaintext, testSecret, testSalt);
    const decrypted = decrypt(encrypted, testSecret, testSalt);
    const match = decrypted === testPlaintext;
    console.log(`  Encrypted: ${encrypted.substring(0, 40)}...`);
    console.log(`  Decrypted: ${decrypted}`);
    console.log(`  Round-trip: ${match ? "PASS" : "FAIL"}\n`);

    if (match) {
      console.log("  Crypto is working. The problem is that the passphrase or salt");
      console.log("  in .env doesn't match what was used during encryption.\n");
      console.log("  RECOMMENDATION: Re-encrypt your API key:");
      console.log("    node scripts/encrypt-key.js");
      console.log("  Then update ANTHROPIC_API_KEY_ENCRYPTED in .env.\n");
    }
  } catch (err) {
    console.log(`  FAILED — crypto error: ${err.message}\n`);
  }

  rl.close();
}

main().catch(err => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
