// ═══════════════════════════════════════════════════════════════
// src/db/with-tenant.js — per-request tenant context via
// AsyncLocalStorage + PostgreSQL SET LOCAL
// ═══════════════════════════════════════════════════════════════
// Usage:
//   import { withTenant, currentTenantId } from './with-tenant.js';
//
//   // In a route handler or scheduler loop:
//   await withTenant(tenantUuid, async (client) => {
//     // client has SET LOCAL app.current_tenant_id = tenantUuid
//     // RLS policies enforce visibility automatically
//     const r = await client.query('SELECT * FROM posts');
//     // currentTenantId() returns tenantUuid inside this block
//   });
//   // After the block: transaction committed, context cleared.
//
// The callback receives a dedicated pg.Client (checked out from
// the pool) that is wrapped in a transaction with SET LOCAL
// applied. The AsyncLocalStorage store holds both the tenant id
// and the client so that downstream modules (like credential-
// store.js) can access them without explicit parameter passing.
//
// ── Phase 0 instrumentation note ─────────────────────────────
// This function is the single chokepoint through which every
// tenant-scoped database access passes, which makes it the only
// place worth measuring. Three numbers are recorded per call:
//
//   waitMs  how long pool.connect() queued before handing back a
//           client. Above zero means the pool is saturated.
//   holdMs  how long the client stayed checked out. Because the
//           callback runs inside BEGIN/COMMIT, this is also how
//           long a PostgreSQL snapshot stayed pinned.
//   site    the calling file and line, captured ONLY when holdMs
//           crosses the slow threshold.
//
// The instrumentation is deliberately observation-only. Control
// flow, the transaction shape, the propagated error, and the
// release semantics are unchanged from 2.5.72. Two known defects
// are preserved here on purpose so that Phase 0 cannot be blamed
// for a behavior change. Both are scheduled for Phase 1a:
//
//   1. client.release() is called with no error argument, so a
//      client whose connection died mid-transaction is returned
//      to the pool marked healthy.
//   2. The ROLLBACK in the catch is unguarded. If it throws, it
//      replaces the original error and the true cause is lost.
// ═══════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "./pool.js";
import {
  noteTransactionOpen,
  recordTransaction,
  recordAcquireFailure,
  captureCallSite,
  getSlowTransactionMs,
  isSiteCaptureEnabled
} from "../services/runtime-metrics.js";

const als = new AsyncLocalStorage();

// Monotonic clock in fractional milliseconds. process.hrtime.bigint
// is immune to wall-clock adjustment, which matters because the
// start script runs ntpdate and a Date.now() delta could go
// negative across a time step.
function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

// ── Public API ───────────────────────────────────────────────

// Returns the current tenant UUID, or null if called outside
// a withTenant block. Safe to call from anywhere — never throws.
export function currentTenantId() {
  const store = als.getStore();
  return store ? store.tenantId : null;
}

// Returns the dedicated pg.Client for the current tenant
// transaction, or null if called outside a withTenant block.
// Used by internal modules like credential-store.js. Not part
// of the public-facing API for route handlers — they get the
// client as a callback parameter from withTenant.
export function currentClient() {
  const store = als.getStore();
  return store ? store.client : null;
}

// Wraps `fn` in a PostgreSQL transaction with the tenant
// context set via SET LOCAL. The callback receives the
// dedicated client as its first argument.
//
// On success: COMMIT, client released to pool.
// On error:   ROLLBACK, client released, error re-thrown.
//
// SET LOCAL is transaction-scoped — the setting is
// automatically cleared when the transaction ends, so a
// pooled connection can never leak tenant context to a
// subsequent request.
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

  try {
    await client.query("BEGIN");
    // SET LOCAL does not accept parameterized placeholders ($1, $2)
    // in PostgreSQL — it's a utility command parsed outside the
    // regular bind protocol. Use set_config(name, value, is_local)
    // instead. The `true` third argument makes it transaction-
    // scoped, equivalent to SET LOCAL.
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId]
    );
    const result = await als.run({ tenantId, client }, () => fn(client));
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
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
