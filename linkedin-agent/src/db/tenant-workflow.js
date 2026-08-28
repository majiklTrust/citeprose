// ===============================================================
// src/db/tenant-workflow.js - leased tenant context for long
// workflows (Item #1 Phase 2, 4.25111.28)
// ===============================================================
// withTenant (with-tenant.js) fuses THREE things into one envelope:
// tenant identity (the RLS GUC), a pinned pool client, and a
// BEGIN..COMMIT transaction. For request handlers that shape is
// right: the work IS one short transaction. A generation workflow
// is different: minutes of Model Provider latency with brief bursts
// of database work in between. Under withTenant the whole workflow
// pins one connection and holds one open transaction for its entire
// wall time, so connection hold no longer tracks database work.
//
// This module splits the fusion. withTenantWorkflow establishes the
// DURABLE part of the context (which tenant, for how long) while the
// EPHEMERAL part (a pooled client inside BEGIN..COMMIT with the GUC
// set) is a short-lived LEASE, acquired on the first query after any
// yield and surrendered at the next yieldDb() or at workflow end.
// Between leases the workflow holds no connection, no transaction,
// no snapshot, and no locks.
//
//   withTenantWorkflow(tenantId, opts, fn)
//       fn runs with currentTenantId()/currentClient() answering
//       exactly as they do under withTenant. opts.readOnly === true
//       opens every lease as BEGIN READ ONLY, so any write attempt
//       fails loudly with read_only_sql_transaction instead of
//       depending on a later rollback to erase it.
//   yieldDb()
//       Commit and release the current lease, if one is open. Under
//       classic withTenant (or outside any tenant scope) this is a
//       NO-OP, which is what lets shared pipeline code carry yield
//       points without changing production behavior at all.
//
// The one shared-code contract that makes this transparent: every
// tenant-scoped module reaches the database through currentClient()
// (or the withTenant callback argument) and only ever calls .query()
// on it. The store this module enters carries a query-only FACADE as
// its client; the facade acquires the lease on demand, so a caller
// written against withTenant works unchanged. SAVEPOINT flows and
// other client-level features are NOT part of the facade; the
// workflow callers converted so far (the Generation Lab) do not use
// them, and production conversion is Phase 3's concern.
//
// Correctness properties, in the order they matter:
//
//   1. TENANT SCOPE PER LEASE. app.current_tenant_id is transaction
//      scoped (set_config is_local=true), so it dies with each
//      lease. Every lease opener re-establishes it in the same fused
//      round trip withTenant uses, behind the same strict UUID
//      validation, so no statement can ever run on a leased client
//      without the tenant GUC in force. FORCE RLS then makes a bare
//      client indistinguishable from a denied one.
//   2. SMALL ABORT DOMAINS. A statement error aborts only the lease
//      it ran in: the facade rolls the lease back and drops it, so a
//      caller that catches the error (metric-store's fetch guard,
//      for one) resumes on a FRESH transaction instead of hitting
//      25P02 in_failed_sql_transaction on every later statement,
//      which is what happens under a single long envelope.
//   3. HONEST ACCOUNTING. Each lease reports through the SAME
//      runtime-metrics contract as withTenant (waitMs, holdMs,
//      slow-site capture), so the pool dashboard sees leases as what
//      they are: short transactions. Broken connections release with
//      the error and are destroyed, never repooled healthy.
//
// What this module deliberately does NOT change: a nested classic
// withTenant call (the spend recorder's own short write transaction)
// shadows the workflow store for its callback, exactly as it shadows
// a request store today, and keeps its own client. READ COMMITTED
// takes a new snapshot per statement, so splitting one long
// transaction into leases does not change what the workflow's reads
// can observe; it changes only how long connections are held.
// ===============================================================

import { pool } from "./pool.js";
import { resetSavepointScope } from "./savepoint.js";
import { enterTenantScope, currentTenantScope, UUID_RE } from "./with-tenant.js";
import {
  noteTransactionOpen,
  recordTransaction,
  recordAcquireFailure,
  captureCallSite,
  getSlowTransactionMs,
  isSiteCaptureEnabled
} from "../services/runtime-metrics.js";

// Same monotonic clock as with-tenant.js, for the same reason: the
// start script steps the wall clock and a Date.now() delta could go
// negative across the adjustment.
function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

// Lease lock discipline (Item #1 Phase 3): OPT-IN via env
// LEASE_LOCK_TIMEOUT_MS. When set to a positive integer, every lease
// opens with that transaction-scoped lock_timeout, so a workflow
// statement that would otherwise queue indefinitely behind another
// session's lock fails loudly instead. Unset (the default) changes
// nothing: leases wait exactly as classic withTenant transactions
// do. Read once per workflow, not per lease, so one run cannot see
// two different disciplines.
function leaseLockTimeoutMs() {
  const n = parseInt(process.env.LEASE_LOCK_TIMEOUT_MS, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// -- Lease lifecycle --------------------------------------------

// Acquire the workflow's client and open its transaction. Callers
// race through here on the shared `acquiring` promise so concurrent
// awaited queries inside one workflow can never double-acquire.
async function ensureLease(state) {
  if (state.lease) return state.lease;
  if (state.acquiring) return state.acquiring;
  state.acquiring = (async () => {
    const tStart = nowMs();
    let client;
    try {
      client = await pool.connect();
    } catch (acquireErr) {
      recordAcquireFailure(nowMs() - tStart);
      throw acquireErr;
    }
    const tAcquired = nowMs();
    noteTransactionOpen();
    // Same per-transaction savepoint hygiene as withTenant: the
    // pooled client may have served a SAVEPOINT-taking caller
    // moments ago, and the count must not survive into this lease.
    resetSavepointScope(client);
    try {
      // Fused opener, one round trip: BEGIN (READ ONLY when asked)
      // plus the transaction-scoped tenant GUC, plus the optional
      // lease lock_timeout (Item #1 Phase 3). All literals are safe:
      // tenantId matched UUID_RE at workflow entry and the timeout is
      // a validated integer. Both settings are is_local, so they die
      // with the lease and can never leak into a pooled connection.
      const lockMs = state.lockTimeoutMs;
      await client.query(
        `BEGIN${state.readOnly ? " READ ONLY" : ""};` +
        `SELECT set_config('app.current_tenant_id','${state.tenantId}',true)` +
        (lockMs ? `,set_config('lock_timeout','${lockMs}ms',true)` : "")
      );
    } catch (openErr) {
      // Nothing usable was established. Destroy rather than repool:
      // a client whose BEGIN failed is a client to be suspicious of.
      client.release(openErr);
      recordTransaction({
        waitMs: tAcquired - tStart,
        holdMs: nowMs() - tAcquired,
        ok: false,
        site: null
      });
      throw openErr;
    }
    const lease = { client, tAcquired, waitMs: tAcquired - tStart };
    state.lease = lease;
    return lease;
  })();
  try {
    return await state.acquiring;
  } finally {
    state.acquiring = null;
  }
}

// Close the current lease, if any. `cause` null means the lease work
// succeeded and the lease COMMITs; a close failure then surfaces to
// the caller, because a commit that did not happen must never be
// reported as one that did. `cause` non-null means an error is
// already propagating: the lease ROLLs BACK and any close failure is
// recorded but never thrown, so the ORIGINAL error always wins,
// mirroring withTenant's guarded rollback.
async function closeLease(state, cause) {
  const lease = state.lease;
  if (!lease) return;
  state.lease = null;
  const { client } = lease;
  let committed = false;
  let broken = null;
  try {
    if (cause) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
      committed = true;
    }
  } catch (closeErr) {
    broken = closeErr;
    console.error(
      "[PLATFORM:ERROR] db_lease_close_failed",
      JSON.stringify({
        close: closeErr && closeErr.message,
        original: cause && cause.message
      })
    );
  } finally {
    if (!broken && client._queryable === false) {
      broken = new Error("connection no longer queryable after lease");
    }
    client.release(broken || undefined);
    const holdMs = nowMs() - lease.tAcquired;
    const slow = holdMs >= getSlowTransactionMs();
    recordTransaction({
      waitMs: lease.waitMs,
      holdMs,
      ok: committed,
      site: slow && state.siteMarker ? captureCallSite(state.siteMarker) : null
    });
  }
  if (broken && !cause) throw broken;
}

// The query-only client facade stored in ALS. Deliberately minimal:
// tenant-scoped modules call exactly .query() on currentClient(),
// and anything beyond that (release, savepoints, connection fields)
// is a withTenant-envelope concern the workflow does not offer.
function makeFacade(state) {
  return {
    query: async (textOrConfig, params) => {
      const lease = await ensureLease(state);
      try {
        return await lease.client.query(textOrConfig, params);
      } catch (err) {
        // Property 2 above: the failed statement takes down only its
        // own lease. Roll back, drop, rethrow the original; the next
        // query after a caught error starts a fresh transaction.
        await closeLease(state, err);
        throw err;
      }
    }
  };
}

// -- Public API -------------------------------------------------

// Run `fn` under a leased tenant context. `opts` may be omitted.
// opts.readOnly === true makes every lease a READ ONLY transaction.
export async function withTenantWorkflow(tenantId, opts, fn) {
  if (typeof opts === "function") {
    fn = opts;
    opts = {};
  }
  // The workflow inlines the tenant id into every lease opener, so
  // unlike withTenant there is no parameterized fallback: a non-UUID
  // tenant is refused outright. Every real caller passes tenants.id.
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new Error("withTenantWorkflow requires a tenant UUID");
  }
  const state = {
    tenantId,
    readOnly: !!(opts && opts.readOnly === true),
    lockTimeoutMs: leaseLockTimeoutMs(),
    lease: null,
    acquiring: null,
    siteMarker: isSiteCaptureEnabled() ? new Error("withTenantWorkflow call site") : null
  };
  const facade = makeFacade(state);
  // The store shape matches withTenant's ({ tenantId, client }), so
  // currentTenantId() and currentClient() answer without knowing
  // which envelope they are inside. `workflow` is the marker yieldDb
  // dispatches on; classic stores do not carry it.
  const store = { tenantId, client: facade, workflow: state };
  try {
    const result = await enterTenantScope(store, () => fn(facade));
    await closeLease(state, null);
    return result;
  } catch (err) {
    await closeLease(state, err);
    throw err;
  }
}

// Surrender the current lease at a natural pause, typically right
// before a Model Provider crossing whose latency dwarfs any database
// burst. Under classic withTenant or outside any tenant scope this
// is a no-op, so shared pipeline code calls it unconditionally.
export async function yieldDb() {
  const store = currentTenantScope();
  const state = store ? store.workflow : null;
  if (!state) return;
  await closeLease(state, null);
}
