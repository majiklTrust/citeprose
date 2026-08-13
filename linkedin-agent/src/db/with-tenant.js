// ===============================================================
// src/db/with-tenant.js - per-request tenant context via
// AsyncLocalStorage + PostgreSQL set_config (v2)
// ===============================================================
// Drop-in replacement for the original with-tenant.js. Public API,
// module path, ALS semantics, and the runtime-metrics recording
// contract are IDENTICAL:
//
//   withTenant(tenantId, fn)  - fn(client) inside BEGIN..COMMIT with
//                               app.current_tenant_id set for RLS
//   currentTenantId()         - tenant UUID or null outside a block
//   currentClient()           - the dedicated client or null
//
// The client stored in ALS and the client passed to fn are the SAME
// object, so callback-arg consumers (feeds-api, image-studio-api)
// and currentClient() consumers (credential-store, database.js)
// always share one connection and one transaction. SAVEPOINT flows
// (advocacy-reach), FOR UPDATE / SKIP LOCKED, and current_tenant_id()
// in SQL all keep working unchanged.
//
// What changed (performance and pool hygiene only):
//
//   1. ONE ROUND TRIP TO OPEN. The original issued BEGIN and then
//      SELECT set_config(...) as two awaited round trips on every
//      transaction. tenantId is a UUID in every real call path
//      (tenants.id), so after strict validation the two statements
//      are fused into a single simple-protocol query:
//         BEGIN; SELECT set_config('app.current_tenant_id','<id>',true)
//      Anything that does not match the UUID grammar falls back to
//      the original two-step parameterized path, byte-for-byte.
//      Per-transaction overhead drops from 3 round trips
//      (BEGIN + set_config + COMMIT) to 2.
//
//   2. GUARDED ROLLBACK. The original ROLLBACK was unguarded: if it
//      threw (dead connection), it REPLACED the original error and
//      the true cause was lost. Now the original error always
//      propagates; a rollback failure is recorded and the client is
//      handed back as broken. (This was documented in the original
//      as a known defect scheduled for Phase 1a.)
//
//   3. HONEST RELEASE. The original always called client.release()
//      with no argument, so a client whose connection died mid-
//      transaction went back into the pool marked healthy and
//      poisoned later checkouts. Now a client that is no longer
//      queryable (connection-level failure or failed rollback) is
//      released with the error, which destroys it and lets the pool
//      open a fresh replacement. (Also a documented Phase 1a fix.)
//
// -- Phase 0 instrumentation (unchanged) -----------------------
// This function remains the single chokepoint through which every
// tenant-scoped database access passes. Three numbers are recorded
// per call:
//
//   waitMs  how long pool.connect() queued before handing back a
//           client. Above zero means the pool is saturated.
//   holdMs  how long the client stayed checked out. Because the
//           callback runs inside BEGIN/COMMIT, this is also how
//           long a PostgreSQL snapshot stayed pinned.
//   site    the calling file and line, captured ONLY when holdMs
//           crosses the slow threshold.
// ===============================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "./pool.js";
import { resetSavepointScope } from "./savepoint.js";
import {
  noteTransactionOpen,
  recordTransaction,
  recordAcquireFailure,
  captureCallSite,
  getSlowTransactionMs,
  isSiteCaptureEnabled
} from "../services/runtime-metrics.js";

const als = new AsyncLocalStorage();

// Strict UUID grammar (8-4-4-4-12 hex). Only a value matching this
// is ever inlined into the fused opener, which makes the inline
// literal injection-proof by construction. Anything else takes the
// original parameterized path.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Monotonic clock in fractional milliseconds. process.hrtime.bigint
// is immune to wall-clock adjustment, which matters because the
// start script runs ntpdate and a Date.now() delta could go
// negative across a time step.
function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

// -- Public API -------------------------------------------------

// Returns the current tenant UUID, or null if called outside
// a withTenant block. Safe to call from anywhere - never throws.
export function currentTenantId() {
  const store = als.getStore();
  return store ? store.tenantId : null;
}

// Returns the dedicated pg.Client for the current tenant
// transaction, or null if called outside a withTenant block.
// Used by internal modules like credential-store.js. Not part
// of the public-facing API for route handlers - they get the
// client as a callback parameter from withTenant.
export function currentClient() {
  const store = als.getStore();
  return store ? store.client : null;
}

// Wraps `fn` in a PostgreSQL transaction with the tenant
// context set via set_config (transaction-scoped, equivalent to
// SET LOCAL). The callback receives the dedicated client as its
// first argument.
//
// On success: COMMIT, client released to pool.
// On error:   ROLLBACK (guarded), client released, ORIGINAL error
//             re-thrown. A client with a broken connection is
//             destroyed instead of returned to the pool.
//
// The transaction-scoped setting is automatically cleared when the
// transaction ends, so a pooled connection can never leak tenant
// context to a subsequent request.
export async function withTenant(tenantId, fn) {
  // Constructed before the first await so V8 captures a stack
  // that still contains the originating frame. Formatting is
  // lazy: the cost is paid inside captureCallSite, and only for
  // transactions that turn out to be slow.
  const siteMarker = isSiteCaptureEnabled() ? new Error("withTenant call site") : null;
  const tStart = nowMs();

  let client;
  try {
    client = await pool.connect();
  } catch (acquireErr) {
    // Nothing was opened, so nothing is decremented. This is the
    // saturation signal: connectionTimeoutMillis elapsed and the
    // caller is about to return a 500 to a user.
    recordAcquireFailure(nowMs() - tStart);
    throw acquireErr;
  }

  const tAcquired = nowMs();
  const waitMs = tAcquired - tStart;
  noteTransactionOpen();
  let committed = false;
  let broken = null; // non-null: connection must not go back to the pool

  // Savepoints do not survive COMMIT or ROLLBACK, so the count of
  // savepoints taken must not survive either. A pooled client is
  // handed out again for the NEXT transaction, and carrying the
  // count forward would walk it into the per-transaction cap and
  // silently disable failure isolation for the remaining life of
  // that connection. Reset BEFORE the opener rather than after, so
  // the scope is clean even if BEGIN itself fails and the client is
  // later reused.
  resetSavepointScope(client);

  try {
    if (typeof tenantId === "string" && UUID_RE.test(tenantId)) {
      // Fused opener: one simple-protocol round trip for BEGIN plus
      // the transaction-scoped tenant setting. The literal is safe
      // because it matched the strict UUID grammar above. set_config
      // with is_local=true is used instead of SET LOCAL because
      // SET LOCAL takes no parameters and this form keeps the two
      // paths semantically identical.
      await client.query(
        `BEGIN;SELECT set_config('app.current_tenant_id','${tenantId}',true)`
      );
    } else {
      // Fallback: exactly the original two-step path for any caller
      // that passes a non-UUID value.
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId]
      );
    }

    const result = await als.run({ tenantId, client }, () => fn(client));
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    // Guarded rollback: the ORIGINAL error always wins. If the
    // rollback itself fails the connection is unusable; mark it so
    // release() destroys it rather than repooling a poisoned client.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr;
      console.error(
        "[PLATFORM:ERROR] db_txn_rollback_failed",
        JSON.stringify({
          rollback: rollbackErr && rollbackErr.message,
          original: err && err.message
        })
      );
    }
    throw err;
  } finally {
    // A client that stopped being queryable mid-transaction
    // (connection dropped, server restarted) must not be returned
    // as healthy. pg marks this on the client; releasing with an
    // Error destroys the connection and the pool replaces it.
    if (!broken && client._queryable === false) {
      broken = new Error("connection no longer queryable after transaction");
    }
    client.release(broken || undefined);
    // Recorded after release so holdMs spans the full period the
    // connection was unavailable to any other caller. recordTransaction
    // swallows its own failures, so this can never mask the error
    // currently propagating out of the catch.
    const holdMs = nowMs() - tAcquired;
    const slow = holdMs >= getSlowTransactionMs();
    recordTransaction({
      waitMs,
      holdMs,
      ok: committed,
      site: slow && siteMarker ? captureCallSite(siteMarker) : null
    });
  }
}
