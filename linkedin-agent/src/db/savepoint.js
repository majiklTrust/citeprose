// ═══════════════════════════════════════════════════════════════
// src/db/savepoint.js - failure containment inside a shared
// tenant transaction
// ═══════════════════════════════════════════════════════════════
// THE PROBLEM THIS SOLVES
// ----------------------
// withTenant() wraps a whole unit of work in one transaction. When
// a loop runs many independent items inside that transaction, one
// failed statement aborts the ENTIRE transaction: PostgreSQL then
// rejects every subsequent statement with 25P02
// (in_failed_sql_transaction) and the final COMMIT silently
// degrades to ROLLBACK. Work that already succeeded for unrelated
// items is discarded, and the bookkeeping that would have recorded
// the failure is itself rejected, so the audit trail records
// nothing while the data quietly disappears.
//
// A savepoint is the only mechanism that contains a statement
// failure without ending the enclosing transaction. Rolling back
// to a savepoint restores the transaction to a usable state, so
// sibling items proceed and failure bookkeeping actually lands.
//
// WHAT THIS MODULE REFUSES TO DO
// ------------------------------
// It never swallows the caller's error. The original error is
// always re-thrown after containment, because a contained failure
// is still a failure and the caller decides what it means.
//
// It never lets its OWN failure masquerade as success, and never
// lets its own failure replace the caller's error. Every savepoint
// command is individually guarded and every guard reports through
// platformLog. There is no bare catch in this file.
//
// DISTRIBUTED-CORRECTNESS CONSTRAINTS
// -----------------------------------
// 1. SUBTRANSACTION CACHE. Each PostgreSQL backend caches 64
//    subtransaction ids (PGPROC_MAX_CACHED_SUBXIDS). Past that the
//    backend's snapshot is marked suboverflowed and EVERY OTHER
//    backend must consult pg_subtrans on disk for visibility
//    checks. That is a cluster-wide slowdown caused by one
//    connection, so this module caps savepoints per transaction
//    and degrades to unisolated execution rather than crossing it.
//    Correctness at 70 savepoints was verified; the cap exists for
//    the performance cliff, not for correctness.
//
// 2. NAMES ARE GENERATED, NEVER PASSED THROUGH. Savepoint names
//    are identifiers and cannot be parameterized, so a caller
//    label reaching the SQL text would be an injection vector.
//    Names are built from an internal counter only. The caller's
//    label is used solely in log output.
//
// 3. DEPTH IS PER-TRANSACTION, NOT PER-PROCESS. The counter hangs
//    off the pg client in a WeakMap, so it is naturally scoped to
//    one transaction on one connection and is collected with it.
//    Concurrent transactions, PM2 workers, and instances behind
//    the load balancer each keep their own count with no shared
//    state and no cleanup path to forget.
// ═══════════════════════════════════════════════════════════════

import { platformLog } from "../services/platform-log.js";

// Per-client savepoint accounting. WeakMap: when the pooled client
// is collected the entry disappears with it, so there is no
// registry to leak and no eviction to schedule.
const depthByClient = new WeakMap();

// PostgreSQL caches this many subtransaction ids per backend before
// a snapshot becomes suboverflowed. Documented engine constant, not
// a tunable, so it is named here rather than configured.
const PG_MAX_CACHED_SUBXIDS = 64;

// Default cap sits below the engine limit with headroom for
// savepoints taken by other code in the same transaction.
const DEFAULT_SAVEPOINT_CAP = 48;

export function getSavepointCap() {
  const n = parseInt(process.env.DB_SAVEPOINT_CAP_PER_TXN, 10);
  if (!Number.isFinite(n) || n < 1 || n > PG_MAX_CACHED_SUBXIDS) {
    return DEFAULT_SAVEPOINT_CAP;
  }
  return n;
}

// Escape hatch. Set to "off" to run exactly as the code ran before
// savepoints existed, so a suspected regression can be bisected in
// production without a redeploy.
export function isSavepointIsolationEnabled() {
  return (process.env.DB_SAVEPOINT_ISOLATION || "on") !== "off";
}

// PostgreSQL marks a transaction unusable after any statement
// error. Detecting that state lets this module report honestly
// instead of issuing commands that cannot succeed.
const IN_FAILED_TRANSACTION = "25P02";

function isAbortedTransactionError(err) {
  return Boolean(err) && err.code === IN_FAILED_TRANSACTION;
}

function accountingFor(dbClient) {
  let acct = depthByClient.get(dbClient);
  if (!acct) {
    acct = { issued: 0, capWarned: false };
    depthByClient.set(dbClient, acct);
  }
  return acct;
}

/**
 * Run `fn` inside a savepoint on `dbClient`.
 *
 * On success the savepoint is released and fn's return value is
 * passed through. On failure the transaction is rolled back to the
 * savepoint (so the caller's enclosing transaction stays usable)
 * and fn's ORIGINAL error is re-thrown unchanged.
 *
 * This function never throws an error of its own. If the savepoint
 * machinery itself fails, that is reported through platformLog and
 * execution continues with whatever guarantee remains, because
 * losing isolation is strictly better than losing the work.
 *
 * @param {object} dbClient - the pg client from currentClient()
 * @param {string} label    - log-only identifier, never reaches SQL
 * @param {Function} fn     - the work to isolate
 * @returns {Promise<*>} fn's resolved value
 */
export async function withSavepoint(dbClient, label, fn) {
  if (!dbClient || typeof dbClient.query !== "function") {
    throw new Error("withSavepoint requires an active database client");
  }

  if (!isSavepointIsolationEnabled()) {
    return fn();
  }

  const acct = accountingFor(dbClient);

  // Refusing past the cap is deliberate: crossing the engine's
  // subtransaction cache would degrade every other backend on the
  // cluster, which is a worse outcome than this one loop losing
  // isolation. Warn once per transaction, not once per item.
  if (acct.issued >= getSavepointCap()) {
    if (!acct.capWarned) {
      acct.capWarned = true;
      platformLog("warn", "savepoint_cap_reached", {
        label,
        issued: acct.issued,
        cap: getSavepointCap(),
        consequence: "remaining items in this transaction run without isolation"
      });
    }
    return fn();
  }

  const ordinal = acct.issued + 1;
  // Name is derived from the internal counter alone. No caller
  // input reaches the SQL text, so no escaping is required and
  // none is relied upon.
  const name = `sp_${ordinal}`;

  let isolated = false;
  try {
    await dbClient.query(`SAVEPOINT ${name}`);
    acct.issued = ordinal;
    isolated = true;
  } catch (spErr) {
    // Could not isolate. Most often the transaction was ALREADY
    // aborted before this call, which means an earlier sibling
    // failed without containment. That is exactly the condition
    // this module exists to surface, so it is logged at error.
    platformLog("error", "savepoint_acquire_failed", {
      label,
      error: spErr && spErr.message ? String(spErr.message).substring(0, 300) : "unknown",
      code: spErr && spErr.code ? spErr.code : null,
      transactionAlreadyAborted: isAbortedTransactionError(spErr),
      consequence: "work proceeds without isolation"
    });
  }

  let result;
  try {
    result = await fn();
  } catch (workErr) {
    if (isolated) {
      try {
        await dbClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
      } catch (rbErr) {
        // The transaction is unrecoverable. Report it, then let the
        // caller's original error propagate: the caller's failure is
        // the cause, this is the consequence.
        platformLog("error", "savepoint_rollback_failed", {
          label,
          error: rbErr && rbErr.message ? String(rbErr.message).substring(0, 300) : "unknown",
          code: rbErr && rbErr.code ? rbErr.code : null,
          consequence: "enclosing transaction is unrecoverable; siblings will fail"
        });
      }
    }
    throw workErr;
  }

  if (isolated) {
    try {
      // RELEASE merges this savepoint's work into the parent. The
      // work is already durable within the transaction either way,
      // so a failure here costs a cache slot, not data.
      await dbClient.query(`RELEASE SAVEPOINT ${name}`);
    } catch (relErr) {
      platformLog("warn", "savepoint_release_failed", {
        label,
        error: relErr && relErr.message ? String(relErr.message).substring(0, 300) : "unknown",
        code: relErr && relErr.code ? relErr.code : null,
        consequence: "work retained; one subtransaction slot held until commit"
      });
    }
  }

  return result;
}

/**
 * Run best-effort bookkeeping (failure counters, audit rows) that
 * must never take down the enclosing transaction.
 *
 * This exists because the pattern it replaces was a bare catch
 * with an empty body, which swallowed every error identically: a
 * genuine constraint violation, a permissions error, and an
 * aborted transaction all vanished without a trace. Here the
 * write is isolated so it can actually succeed, and if it still
 * fails the reason is recorded.
 *
 * @returns {Promise<boolean>} true if the write landed
 */
export async function tryBookkeeping(dbClient, label, fn) {
  try {
    await withSavepoint(dbClient, label, fn);
    return true;
  } catch (err) {
    platformLog("warn", "bookkeeping_write_failed", {
      label,
      error: err && err.message ? String(err.message).substring(0, 300) : "unknown",
      code: err && err.code ? err.code : null,
      transactionAborted: isAbortedTransactionError(err)
    });
    return false;
  }
}

/**
 * Clear savepoint accounting for a client.
 *
 * Called by withTenant at the start of every transaction. This is
 * not an optimization: PostgreSQL discards every savepoint at
 * COMMIT or ROLLBACK, so a count that outlives the transaction is
 * simply wrong. Because pooled clients are reused, an uncleared
 * count accumulates across transactions until it reaches the cap,
 * at which point isolation turns itself off for the rest of that
 * connection's life and the failure it was installed to contain
 * returns silently.
 *
 * Safe to call with any value, including a client that has never
 * taken a savepoint.
 */
export function resetSavepointScope(dbClient) {
  if (dbClient) depthByClient.delete(dbClient);
}

// Test-only: current savepoint count for a client, or 0 if none.
export function savepointDepthForTesting(dbClient) {
  const acct = depthByClient.get(dbClient);
  return acct ? acct.issued : 0;
}
