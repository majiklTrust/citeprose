// ===============================================================
// src/db/pool.js - PostgreSQL connection pool singleton (v2)
// ===============================================================
// Drop-in replacement for the original pool.js. The public surface
// is IDENTICAL and every consumer contract is preserved:
//
//   exports: pool, query(text, params), poolGauge(), closePool(),
//            connectionInfo
//   pool is a real pg.Pool: EventEmitter ('error' listener attached
//   here), pool.connect() -> client with .query/.release, live
//   counters pool.totalCount / idleCount / waitingCount and
//   pool.options.max (read by poolGauge and runtime-metrics).
//
// What changed (performance only, no behavior change for callers):
//
//   1. TRANSPARENT PREPARED STATEMENTS. The pool hands out a
//      pg.Client subclass whose query() attaches a stable statement
//      name to repeated parameterized texts (see statement-cache.js).
//      The server parses/plans each hot query once per connection
//      instead of on every execution. Result shapes, type parsing,
//      SQLSTATE codes, .fields/.command/.rowCount are all untouched
//      because this is the same extended protocol either way.
//      Disable with PGPOOL_PREPARE=off (required if a transaction-
//      pooling proxy like PgBouncer is ever inserted).
//
//   2. TUNABLE POOL. Every sizing knob is env-overridable with a
//      safe default. max moves from a hardcoded 10 to 20 by
//      default: the app's own runtime metrics identify waiting
//      checkouts as the leading indicator of user-visible 500s, and
//      long-hold transactions (feed discovery, image render) make
//      headroom cheap insurance. Override with PGPOOL_MAX.
//
//   3. CONNECTION HYGIENE. TCP keepalive is on (dead peers are
//      detected instead of discovered mid-query), connections are
//      recycled after PGPOOL_MAX_LIFETIME_S (default 3600) or
//      PGPOOL_MAX_USES checkouts, so server-side session bloat,
//      stale plans, and half-dead sockets age out on their own.
//
//   4. WARM START. PGPOOL_WARM (default 2) connections are opened
//      in the background at load so the first requests after boot
//      do not pay TLS/TCP/auth setup. Failures log and never block
//      startup.
//
// Connection parameters come from process.env. Four are stored
// ENCRYPTED at rest in .env (AES-256-GCM + HKDF, the same scheme
// as the other platform secrets) and decrypted here at load:
//   PGHOST, PGPORT, PGUSER, PGPASSWORD
// PGDATABASE is stored in plaintext (the database name is not a
// secret) and read as-is.
//
// ENCRYPTION_SECRET is already present when this module loads:
// dotenv runs in index.js start() STEP 1, and this module is only
// imported afterwards via the STEP 4 dynamic import.
// ===============================================================

import pg from "pg";
import { decryptPlatformSecret } from "../services/platform-secret.js";
import {
  statementNameFor,
  evictStatement,
  statementCacheStats
} from "./statement-cache.js";

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
      `${name} could not be decrypted - is it encrypted with the current ` +
      `ENCRYPTION_SECRET? (${e.message})`
    );
  }
  if (!plain) {
    throw new Error(`${name} decrypted to an empty value`);
  }
  return plain;
}

function intFromEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === "number" && n < min) return fallback;
  if (typeof max === "number" && n > max) return fallback;
  return n;
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
// config below. PGDATABASE is intentionally left in place - it is not a
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

// ---------------------------------------------------------------
// PreparedClient - pg.Client that names repeated parameterized
// queries so the server reuses the parse/plan. Everything else
// (events, release, escaping, type parsing, errors) is inherited
// untouched. instanceof pg.Client remains true.
// ---------------------------------------------------------------
class PreparedClient extends pg.Client {
  query(config, values, callback) {
    // Only rewrite the (text, values[]) form. Config objects, bare
    // strings (BEGIN / COMMIT / SET LOCAL ROLE / fused openers) and
    // every other overload pass through byte-for-byte.
    if (typeof config === "string" && Array.isArray(values) && values.length > 0) {
      const name = statementNameFor(config, values);
      if (name) {
        const text = config;
        const result = super.query(
          { name, text, values },
          typeof callback === "function" ? callback : undefined
        );
        // SQLSTATE 0A000: "cached plan must not change result type"
        // (DDL changed a relation under a cached plan). Evict so the
        // next execution re-parses. The original promise is returned
        // to the caller untouched, so error propagation, SQLSTATE
        // codes, and transaction handling are exactly as before.
        if (result && typeof result.then === "function") {
          result.then(undefined, (err) => {
            if (err && err.code === "0A000") evictStatement(text);
          });
        }
        return result;
      }
    }
    return super.query(config, values, callback);
  }
}

export const pool = new pg.Pool({
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,
  password: conn.PGPASSWORD,
  database,

  // Pool sizing and lifecycle. Every value is env-overridable.
  max: intFromEnv("PGPOOL_MAX", 20, 1, 200),
  idleTimeoutMillis: intFromEnv("PGPOOL_IDLE_TIMEOUT_MS", 30000, 1000, 3600000),
  connectionTimeoutMillis: intFromEnv("PGPOOL_CONNECT_TIMEOUT_MS", 5000, 100, 120000),
  maxLifetimeSeconds: intFromEnv("PGPOOL_MAX_LIFETIME_S", 3600, 0, 86400),
  maxUses: intFromEnv("PGPOOL_MAX_USES", 50000, 100, 10000000),

  // TCP keepalive: detect dead peers (db restart, LB idle reap)
  // from the socket instead of from a failed query.
  keepAlive: (process.env.PGPOOL_KEEPALIVE || "on") !== "off",
  keepAliveInitialDelayMillis: 10000,

  // Shows up in pg_stat_activity.application_name for operators.
  application_name: process.env.PG_APP_NAME || "linkedin-ai-agent",

  // The prepared-statement subclass. pg.Pool constructs this for
  // every physical connection.
  Client: PreparedClient
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

// Warm start: open a few connections in the background so the first
// requests after boot skip TCP/auth setup. Never blocks module load,
// never throws; a failure here will resurface loudly on first use.
const warmCount = Math.min(
  intFromEnv("PGPOOL_WARM", 2, 0, 50),
  pool.options.max
);
if (warmCount > 0) {
  (async () => {
    try {
      const clients = await Promise.all(
        Array.from({ length: warmCount }, () => pool.connect())
      );
      for (const c of clients) c.release();
    } catch (err) {
      console.error(
        "[PLATFORM:WARN] db_pool_warmup_failed",
        JSON.stringify({ error: err && err.message })
      );
    }
  })();
}

// Convenience wrapper - fires a query against the shared pool without
// checking out a dedicated client. For tenant-scoped work use
// withTenant() from with-tenant.js instead.
export async function query(text, params) {
  return pool.query(text, params);
}

// Phase 0 instrumentation: a point-in-time read of pool saturation.
//
// node-postgres exposes these as live properties on the Pool, so
// this is arithmetic on already-resident counters: no query, no
// round trip, safe to call on a timer.
//
//   total   clients created (idle plus checked out)
//   idle    clients sitting in the pool, available immediately
//   waiting callers queued because every client is checked out
//   max     the configured ceiling
//
// waiting is the number that matters. A value persistently above
// zero means callers are queuing, and once a caller waits longer
// than connectionTimeoutMillis it does not queue further: it
// throws. Sustained waiting is therefore the leading indicator of
// user-visible 500s, not a soft warning.
export function poolGauge() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options ? pool.options.max : null
  };
}

// Diagnostics for the prepared-statement layer. Additive export:
// nothing in the existing codebase depends on it.
export { statementCacheStats };

// Graceful shutdown helper - call from the SIGTERM/SIGINT handler to
// drain the pool before exit.
export async function closePool() {
  await pool.end();
}
