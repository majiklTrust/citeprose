#!/usr/bin/env node
// =================================================================
// scripts/store-prompt.mjs, generic prompt vault seeder
// =================================================================
// Stores (or updates) one encrypted prompt template in prompt_vault
// through the application's own vault module, so the encryption
// scheme has a single source of truth. The plaintext arrives ONLY
// on stdin: it never sits in this repository, on the command line,
// or in shell history, and it is never echoed back.
//
// Usage:
//   node scripts/store-prompt.mjs <key> "<description>" [genre] < prompt.txt
//   cat prompt.txt | node scripts/store-prompt.mjs analytics_narrative "Phase 1 narrative synthesis"
//
// Exit codes: 0 stored, 2 usage error, 3 environment/DB failure.
// =================================================================

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

function die(code, msg) {
  console.error(`[store-prompt] ${msg}`);
  process.exit(code);
}

const [key, description, genre] = process.argv.slice(2);
if (!key || !description) {
  die(2, 'usage: node scripts/store-prompt.mjs <key> "<description>" [genre] < prompt.txt');
}
if (process.stdin.isTTY) {
  die(2, "prompt text must be piped or redirected on stdin (refusing interactive TTY input)");
}

const envPath = path.join(APP_ROOT, ".env");
if (!fs.existsSync(envPath)) die(3, `env file not found at ${envPath}`);
dotenv.config({ path: envPath });

// Read the full plaintext from stdin before touching the database.
let plaintext = "";
for await (const chunk of process.stdin) plaintext += chunk;
plaintext = plaintext.replace(/\r\n/g, "\n");
if (plaintext.trim().length === 0) {
  die(2, "stdin carried no prompt text");
}

// The vault module pulls in pool.js, which decrypts the encrypted
// PG connection vars itself. Import AFTER dotenv so the ciphertext
// and ENCRYPTION_SECRET are present.
let vault;
try {
  vault = await import(
    pathToFileURL(path.join(APP_ROOT, "src/services/prompt-vault.js")).href
  );
} catch (e) {
  die(3, `could not load the vault module (${e.message})`);
}

try {
  if (genre) {
    await vault.storePrompt(key, plaintext, description, genre);
  } else {
    await vault.storePrompt(key, plaintext, description);
  }
  console.log(
    `[store-prompt] stored key="${key}"${genre ? ` genre="${genre}"` : ""} ` +
    `(${plaintext.length} chars, description ${description.length} chars)`
  );
  process.exit(0);
} catch (e) {
  die(3, `store failed (${e.message})`);
}
