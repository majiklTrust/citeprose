/**
// /******* THIS FILE MOVED AND MAY NOT WORK AS DESCRIBED - bindia 3/17/2026 ******
 * LinkedIn AI Agent — API Key Encryption Utility
 *
 * Run this ONCE on your local machine or server to encrypt your raw API key.
 * The output goes into your .env file as ANTHROPIC_API_KEY_ENCRYPTED.
 * Your ENCRYPTION_SECRET and ENCRYPTION_SALT stay separate (ideally set as
 * real OS env vars, not in the .env file at all).
 *
 * Usage:
 *   node scripts/encrypt-key.js
 *
 * You will be prompted for:
 *   1. Your raw Anthropic API key (sk-ant-...)
 *   2. Your chosen encryption passphrase
 *   3. Your chosen encryption salt
 *
 * The script outputs the encrypted string to copy into your .env file.
 * Your raw key is never written to disk.
 */

'use strict';

// const crypto   = require('crypto');
import crypto from 'node:crypto'
// const readline = require('readline');
import readline from 'node:readline'


const rl = readline.createInterface({
  input : process.stdin,
  output: process.stdout,
});

function question(prompt, hidden = false) {
  return new Promise((resolve) => {
    if (hidden && process.stdout.isTTY) {
      // Suppress echoing for sensitive input
      process.stdout.write(prompt);
      process.stdin.setRawMode(true);
      let input = '';
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', function handler(ch) {
        ch = ch.toString();
        if (ch === '\n' || ch === '\r' || ch === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(input);
        } else if (ch === '\u007f') { // backspace
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += ch;
        }
      });
    } else {
      rl.question(prompt, resolve);
    }
  });
}

function encrypt(plaintext, passphrase, salt) {
  const saltBuf    = Buffer.from(salt);
  const derivedKey = crypto.pbkdf2Sync(passphrase, saltBuf, 200_000, 32, 'sha256');
  const iv         = crypto.randomBytes(16);
  const cipher     = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   LinkedIn AI Agent — API Key Encryption Utility  ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
  console.log('This encrypts your Anthropic API key using AES-256-GCM.');
  console.log('Your raw key is never written to disk.\n');

  const rawKey     = await question('Paste your Anthropic API key (sk-ant-...): ', true);
  const passphrase = await question('Choose an encryption passphrase:           ', true);
  const confirm    = await question('Confirm passphrase:                        ', true);

  if (passphrase !== confirm) {
    console.error('\n[ERROR] Passphrases do not match. Aborting.');
    process.exit(1);
  }

  const salt = await question('Choose an encryption salt (any unique string):   ', true);

  if (!salt || salt.trim().length === 0) {
    console.error('\n[ERROR] Salt cannot be empty. Aborting.');
    process.exit(1);
  }

  if (!rawKey.startsWith('sk-ant-')) {
    console.warn('\n[WARN] Key does not start with sk-ant- — double-check it is correct.');
  }

  const encrypted = encrypt(rawKey, passphrase, salt.trim());

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║                  ENCRYPTED KEY                    ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
  console.log('Add this to your .env file:\n');
  console.log(`ANTHROPIC_API_KEY_ENCRYPTED=${encrypted}`);
  console.log(`\nSet these as OS environment variables (NOT in .env):\n`);
  console.log(`ENCRYPTION_SECRET=<your passphrase>`);
  console.log(`ENCRYPTION_SALT=${salt.trim()}`);
  console.log('\n─────────────────────────────────────────────────────');
  console.log('SECURITY TIPS:');
  console.log('  • ANTHROPIC_API_KEY_ENCRYPTED → safe to put in .env or repo secrets');
  console.log('  • ENCRYPTION_SECRET → set as a real OS/server env var, NOT in .env');
  console.log('  • ENCRYPTION_SALT → set as a real OS/server env var, NOT in .env');
  console.log('  • Never commit your .env file to git (it is in .gitignore)');
  console.log('  • Start the agent with:');
  console.log(`    ENCRYPTION_SECRET=yourpassphrase ENCRYPTION_SALT=${salt.trim()} npm run dev`);
  console.log('─────────────────────────────────────────────────────\n');

  rl.close();
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
