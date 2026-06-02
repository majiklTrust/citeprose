#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/dbshell.mjs — Zero Trust manual DB-ops wrapper (Tier 1)
// ═══════════════════════════════════════════════════════════════
// The four PG connection secrets (PGHOST, PGPORT, PGUSER, PGPASSWORD)
// are encrypted at rest in .env. This wrapper decrypts them IN MEMORY
// using the application's own crypto, injects them into THIS process's
// environment, and spawns the requested tool (psql, pg_dump, pg_restore,
// a DDL run, …) inheriting that environment. The plaintext never touches
// disk, shell history, or the command line; when the process exits, the
// plaintext goes with it.
//
// Usage:
//   node scripts/dbshell.mjs psql
//   node scripts/dbshell.mjs pg_dump -Fc -f backup.dump
//   node scripts/dbshell.mjs verify        # preflight: decrypt + connect, no shell
//   node scripts/dbshell.mjs verify <file>  # same, against a candidate .env (deploy staging)
//
// Seamless (optional) — alias the tools in your shell rc so the secure
// path is the default path:
//   APPDIR=/home/ubuntu/linkedin-agent/linkedin-agent
//   alias psql="node $APPDIR/scripts/dbshell.mjs psql"
//   alias pg_dump="node $APPDIR/scripts/dbshell.mjs pg_dump"
//   alias pg_restore="node $APPDIR/scripts/dbshell.mjs pg_restore"
//
// Honest scope: this closes the on-disk / history / command-line exposure
// and gives you one audited path. It is hygiene, not an auth gate — anyone
// who can run it can also read .env directly. Real identity-bound access is
// the Tier 2/3 work (Secrets Manager + SSM, then RDS IAM auth).
// ═══════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");          // linkedin-agent/
const ENCRYPTED = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"];

function die(code, msg) {
  console.error(`[dbshell] ${msg}`);
  process.exit(code);
}

// 0) Parse the command first, so `verify <envfile>` can target a CANDIDATE
//    .env. The deploy pipeline uses this to validate a staged file before
//    promoting it live, so the live .env is never overwritten with values
//    that can't decrypt or connect. Every other mode (and `verify` with no
//    argument) uses the app's real .env.
const [cmd, ...args] = process.argv.slice(2);

// 1) Load the chosen env file (ciphertext for the four encrypted vars +
//    ENCRYPTION_SECRET + plaintext PGDATABASE).
const envPath = (cmd === "verify" && args[0])
  ? path.resolve(args[0])
  : path.join(APP_ROOT, ".env");
if (!fs.existsSync(envPath)) die(2, `env file not found at ${envPath}`);
dotenv.config({ path: envPath, override: true });

// 2) Decrypt with the app's exact crypto — single source of truth, no re-impl.
const { decryptPlatformSecret } = await import(
  pathToFileURL(path.join(APP_ROOT, "src/services/platform-secret.js")).href
);

const creds = {};
for (const v of ENCRYPTED) {
  const cipher = (process.env[v] || "").trim();
  if (!cipher) die(3, `${v} missing from .env`);
  let plain;
  try {
    plain = decryptPlatformSecret(cipher);
  } catch (e) {
    die(3, `${v} could not be decrypted (${e.message}) — encrypted with the current ENCRYPTION_SECRET?`);
  }
  if (!plain) die(3, `${v} decrypted to an empty value`);
  creds[v] = plain;
}
const PGDATABASE = (process.env.PGDATABASE || "").trim();   // plaintext by design
if (!PGDATABASE) die(3, "PGDATABASE missing from .env");

// 3) verify — preflight connect with no interactive shell. Safe to run as a
//    deploy-time gate BEFORE restarting the app: confirms the encrypted .env
//    decrypts and the credentials actually connect.
if (!cmd || cmd === "verify") {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    host: creds.PGHOST,
    port: parseInt(creds.PGPORT, 10),
    user: creds.PGUSER,
    password: creds.PGPASSWORD,
    database: PGDATABASE,
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    const r = await client.query("select current_user, current_database()");
    await client.end();
    console.log(`[dbshell] verify OK [${envPath}] — connected as ${r.rows[0].current_user} to ${r.rows[0].current_database}`);
    process.exit(0);
  } catch (e) {
    try { await client.end(); } catch { /* ignore */ }
    die(4, `verify FAILED — ${e.message}`);
  }
}

// 4) Build the child environment: inherit parent, inject decrypted creds,
//    and remove ENCRYPTION_SECRET so the spawned tool never carries the key.
const childEnv = { ...process.env, ...creds, PGDATABASE };
delete childEnv.ENCRYPTION_SECRET;

// 5) Exec the requested tool with the injected env and inherited stdio.
const child = spawn(cmd, args, { stdio: "inherit", env: childEnv });
child.on("error", (e) => die(127, `failed to launch '${cmd}': ${e.message}`));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
