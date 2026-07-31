// ═══════════════════════════════════════════════════════════════
// src/db/pool.js — PostgreSQL connection pool singleton
// ═══════════════════════════════════════════════════════════════
// Single shared pool for the application. Every query goes through
// this pool or through a dedicated client checked out via
// withTenant() in with-tenant.js.
//
// Connection parameters come from process.env. Four are stored
// ENCRYPTED at rest in .env (AES-256-GCM + HKDF — the same scheme
// as the other platform secrets) and decrypted here at load:
//   PGHOST, PGPORT, PGUSER, PGPASSWORD
// PGDATABASE is stored in plaintext (the database name is not a
// secret) and read as-is.
//
// ENCRYPTION_SECRET is already present when this module loads:
// dotenv runs in index.js start() STEP 1, and this module is only
// imported afterwards via the STEP 4 dynamic import.
// ═══════════════════════════════════════════════════════════════

import pg from "pg";
import { decryptPlatformSecret } from "../services/platform-secret.js";

const ENCRYPTED_VARS = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"];

function decryptRequired(name) {
  const cipher = (process.env[name] || "").trim();
  if (!cipher) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  let plain;
  try {
    plain = decryptPlatformSecret(cipher);
  } catch (e) {
    throw new Error(
      `${name} could not be decrypted — is it encrypted with the current ` +
      `ENCRYPTION_SECRET? (${e.message})`
    );
  }
  if (!plain) {
    throw new Error(`${name} decrypted to an empty value`);
  }
  return plain;
}

// Decrypt the four secret connection vars. PGDATABASE stays plaintext.
const conn = {};
for (const v of ENCRYPTED_VARS) conn[v] = decryptRequired(v);

const database = (process.env.PGDATABASE || "").trim();
if (!database) {
  throw new Error("Missing required environment variable: PGDATABASE");
}

const port = parseInt(conn.PGPORT, 10);
if (!Number.isInteger(port) || port < 1) {
  throw new Error("PGPORT did not decrypt to a valid port number");
}

// Scrub the four ciphertexts from the environment so neither ciphertext
// nor plaintext lingers there (e.g. /proc/<pid>/environ or an accidental
// process.env dump). The plaintext lives only in the Pool's in-memory
// config below. PGDATABASE is intentionally left in place — it is not a
// secret and the startup banner reads it via connectionInfo.
for (const v of ENCRYPTED_VARS) delete process.env[v];

// Non-secret connection summary for diagnostics and the startup banner.
// Never includes the password.
export const connectionInfo = {
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,
  database
};

export const pool = new pg.Pool({
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,
  password: conn.PGPASSWORD,
  database,
  // Conservative defaults — tune when concurrency grows.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// 2.5.61: an IDLE client dying (database restart, network drop,
// timeout) emits 'error' on the pool; without a listener that is an
// unhandled 'error' event and Node terminates the whole process.
// A database outage must surface as loud logs and failing requests,
// never as process death. console.error directly: platformLog
// persists THROUGH this pool and must not be in its failure path.
pool.on("error", (err) => {
  console.error(
    "[PLATFORM:ERROR] db_pool_idle_client_error",
    JSON.stringify({ error: err && err.message })
  );
});

// Convenience wrapper — fires a query against the shared pool without
// checking out a dedicated client. For tenant-scoped work use
// withTenant() from with-tenant.js instead.
export async function query(text, params) {
  return pool.query(text, params);
}

// Graceful shutdown helper — call from the SIGTERM/SIGINT handler to
// drain the pool before exit.
export async function closePool() {
  await pool.end();
}
