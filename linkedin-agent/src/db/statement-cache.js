// ===============================================================
// src/db/statement-cache.js - transparent prepared statement names
// ===============================================================
// Internal helper for pool.js. Maps a SQL text to a stable, short
// statement name so node-postgres reuses a server-side prepared
// statement (parse once, bind/execute many) on each connection.
//
// Why this is safe as a drop-in:
//   - Naming a parameterized query does not change the protocol
//     family (it is the extended protocol either way), the result
//     shape, the type conversions, or error propagation. It only
//     skips the server-side parse/plan on repeat executions.
//   - Names are derived from a SHA-1 of the exact SQL text, so a
//     different text can never collide with an existing name on
//     the same connection ("prepared statements can be automatically
//     shared between clients": node-postgres prepares per-connection
//     and tracks which names each connection has seen).
//
// Policy:
//   - Only queries WITH parameter values are ever named. A bare
//     string query (BEGIN, COMMIT, SET LOCAL ROLE ..., the fused
//     transaction opener) stays on the simple protocol untouched.
//   - A text is named starting from its SECOND execution. One-off
//     dynamic SQL (report queries, admin registry SQL) never pays
//     the prepared-statement bookkeeping.
//   - The tracking table is a bounded LRU. Dynamic SET-clause
//     builders (updatePost, transitionPostStatus, searchArticles)
//     produce a small finite family of texts, so the default cap
//     of 500 distinct texts is far above real cardinality; if it
//     ever overflows, eviction just means "back to unnamed", never
//     an error.
//   - PGPOOL_PREPARE=off disables the whole mechanism (for example
//     when fronting the app with a transaction-pooling proxy such
//     as PgBouncer, where named statements do not survive).
//
// Failure containment:
//   - SQLSTATE 0A000 ("cached plan must not change result type")
//     can occur if DDL changes a relation while a plan is cached.
//     pool.js evicts the text on that error so the NEXT execution
//     re-parses; the original error still propagates unchanged so
//     the caller's transaction handling stays exactly as before.
// ===============================================================

import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

function intFromEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === "number" && n < min) return fallback;
  if (typeof max === "number" && n > max) return fallback;
  return n;
}

const MAX_TEXT_LENGTH = 20000; // never track pathological texts

export function isPrepareEnabled() {
  return (process.env.PGPOOL_PREPARE || "on") !== "off";
}

function cacheMax() {
  return intFromEnv("PGPOOL_PREPARE_CACHE_MAX", 500, 16, 10000);
}

function minUses() {
  return intFromEnv("PGPOOL_PREPARE_MIN_USES", 2, 1, 1000);
}

// text -> { name: string|null, uses: number }
const table = new LRUCache({ max: cacheMax() });

let named = 0;      // texts promoted to a server-side name
let namedHits = 0;  // executions that carried a name

function nameFor(text) {
  // 20 hex chars of SHA-1: collision probability is negligible at
  // this cardinality, and the name stays short on the wire.
  return "la_" + createHash("sha1").update(text).digest("hex").slice(0, 20);
}

/**
 * Decide whether this (text, values) execution should be sent as a
 * named prepared statement. Returns the statement name, or null to
 * run it unnamed exactly as before.
 */
export function statementNameFor(text, values) {
  if (!isPrepareEnabled()) return null;
  if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) return null;
  if (!Array.isArray(values) || values.length === 0) return null;

  let entry = table.get(text);
  if (!entry) {
    entry = { name: null, uses: 0 };
    table.set(text, entry);
  }
  entry.uses++;
  if (entry.name) {
    namedHits++;
    return entry.name;
  }
  if (entry.uses >= minUses()) {
    entry.name = nameFor(text);
    named++;
    namedHits++;
    return entry.name;
  }
  return null;
}

/**
 * Drop a text from the tracking table (used on SQLSTATE 0A000 so
 * the next execution re-parses with a fresh plan).
 */
export function evictStatement(text) {
  if (typeof text === "string") table.delete(text);
}

/** Diagnostics for the admin console or ad-hoc inspection. */
export function statementCacheStats() {
  return {
    enabled: isPrepareEnabled(),
    trackedTexts: table.size,
    namedTexts: named,
    namedExecutions: namedHits,
    capacity: cacheMax(),
    minUses: minUses()
  };
}

/** Test-only: reset all tracking state. */
export function _resetStatementCacheForTesting() {
  table.clear();
  named = 0;
  namedHits = 0;
}
