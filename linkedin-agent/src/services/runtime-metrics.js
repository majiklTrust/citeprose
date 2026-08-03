// ═══════════════════════════════════════════════════════════════
// Runtime Metrics (Phase 0): baseline capacity instrumentation
// ═══════════════════════════════════════════════════════════════
//
// Answers three questions no existing surface can answer today:
//
//   1. How long does a withTenant transaction actually hold its
//      pooled connection, and which call sites hold it longest?
//   2. Is the connection pool starving (waitingCount above zero)?
//   3. Is the single event loop blocked, and for how long?
//
// Design rules, all of them non-negotiable because this module
// runs alongside the request path:
//
//   1. Recording NEVER throws and NEVER awaits. recordTransaction
//      is called from a finally block on the hot path; it does
//      arithmetic and array writes only, never I/O.
//   2. Memory is BOUNDED. Duration samples live in a fixed ring
//      buffer; the per-site table is capped. A traffic spike or a
//      hostile caller cannot grow this module without limit.
//   3. Persistence is ONE row per window, not one row per event.
//      A 60 second window costs one INSERT, so instrumentation
//      cannot itself become the pool pressure it is measuring.
//   4. Module load does nothing. No timer, no connection, no
//      query until startRuntimeMetrics() is called explicitly.
//
// Why a dedicated runtime_metric table instead of platform_log:
// platform_log rows are discrete events with jsonb detail, and
// the existing platform-event-metrics console query counts them
// by event name. Writing a gauge sample every 60 seconds into
// that table would swamp those counts and inflate the retention
// prune volume. Time-series numerics belong in their own table.
// ═══════════════════════════════════════════════════════════════

import { monitorEventLoopDelay } from "node:perf_hooks";

// ── Configuration ────────────────────────────────────────────
// Every value is env-overridable with a hardcoded floor as the
// zero-configuration default, matching the posts-window.js and
// config/ai.js pattern: invalid or unset input always falls back
// to a sane value, never NaN.

function intFromEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === "number" && n < min) return fallback;
  if (typeof max === "number" && n > max) return fallback;
  return n;
}

// Emit interval. One INSERT per window.
export function getMetricsWindowMs() {
  return intFromEnv("RUNTIME_METRICS_WINDOW_MS", 60000, 5000, 3600000);
}

// Ring buffer capacity for duration samples. 4000 samples at
// two numbers each is a few hundred kilobytes worst case.
export function getMetricsSampleCap() {
  return intFromEnv("RUNTIME_METRICS_SAMPLE_CAP", 4000, 100, 100000);
}

// A transaction at or above this hold time gets its call site
// captured and attributed. Below it, only the histogram moves.
// Capturing a stack is not free, so the fast path skips it.
export function getSlowTransactionMs() {
  return intFromEnv("RUNTIME_METRICS_SLOW_TXN_MS", 250, 1, 600000);
}

// Distinct call sites tracked per window. A cap is a fail-safe
// against cardinality explosion: once reached, new sites are
// counted in aggregate rather than added as keys.
export function getSiteTableCap() {
  return intFromEnv("RUNTIME_METRICS_SITE_CAP", 100, 5, 1000);
}

// Retention for the runtime_metric table, pruned from this
// module's own interval so no scheduler edit is required.
export function getMetricsRetentionDays() {
  return intFromEnv("RUNTIME_METRICS_RETENTION_DAYS", 14, 1, 3650);
}

// Persistence master switch. Sampling and the in-memory snapshot
// remain available with persistence off, which is the correct
// posture for a dev box with no runtime_metric table applied.
export function isMetricsPersistEnabled() {
  return (process.env.RUNTIME_METRICS_PERSIST || "on") !== "off";
}

// ── Bounded ring buffer ──────────────────────────────────────
// Fixed allocation. Writes wrap. Reads copy only the live span.

function makeRing(cap) {
  return { buf: new Float64Array(cap), cap, len: 0, next: 0 };
}

function ringPush(ring, value) {
  ring.buf[ring.next] = value;
  ring.next = (ring.next + 1) % ring.cap;
  if (ring.len < ring.cap) ring.len++;
}

function ringSnapshot(ring) {
  const out = new Float64Array(ring.len);
  for (let i = 0; i < ring.len; i++) out[i] = ring.buf[i];
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round3(sorted[idx]);
}

function round3(n) {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

// ── Mutable window state ─────────────────────────────────────

let holdRing = null;      // transaction hold durations, ms
let waitRing = null;      // pool acquisition wait durations, ms
let siteTable = null;     // call site to { count, sumMs, maxMs }
let siteOverflow = 0;     // slow transactions dropped by the site cap
let txnCount = 0;
let txnErrorCount = 0;
let acquireFailureCount = 0;   // pool.connect() rejections
let txnOpen = 0;          // transactions currently open
let txnOpenMax = 0;       // high-water mark within the window
let poolWaitingMax = 0;   // pool.waitingCount high-water mark
let poolTotalMax = 0;
let loopHistogram = null;
let timer = null;
let emitCount = 0;
let started = false;

function resetWindow() {
  holdRing = makeRing(getMetricsSampleCap());
  waitRing = makeRing(getMetricsSampleCap());
  siteTable = new Map();
  siteOverflow = 0;
  txnCount = 0;
  txnErrorCount = 0;
  acquireFailureCount = 0;
  txnOpenMax = txnOpen;   // carry the live depth forward, not zero
  poolWaitingMax = 0;
  poolTotalMax = 0;
}

resetWindow();

// ── Hot-path recording API ───────────────────────────────────
// Called from with-tenant.js. Arithmetic and array writes only.

// Increments the live open-transaction depth. Paired with
// recordTransaction, which decrements it.
export function noteTransactionOpen() {
  txnOpen++;
  if (txnOpen > txnOpenMax) txnOpenMax = txnOpen;
}

/**
 * Record one completed withTenant transaction.
 *
 * @param {object} sample
 * @param {number} sample.waitMs  - time spent waiting for a pooled client
 * @param {number} sample.holdMs  - total time the client was checked out
 * @param {boolean} sample.ok     - true on COMMIT, false on ROLLBACK
 * @param {string|null} sample.site - call site, captured only when slow
 */
export function recordTransaction(sample) {
  try {
    if (txnOpen > 0) txnOpen--;
    const holdMs = Number(sample && sample.holdMs);
    const waitMs = Number(sample && sample.waitMs);
    if (Number.isFinite(holdMs)) ringPush(holdRing, holdMs);
    if (Number.isFinite(waitMs)) ringPush(waitRing, waitMs);
    txnCount++;
    if (sample && sample.ok === false) txnErrorCount++;

    const site = sample && sample.site;
    if (typeof site === "string" && site.length > 0) {
      const existing = siteTable.get(site);
      if (existing) {
        existing.count++;
        existing.sumMs += Number.isFinite(holdMs) ? holdMs : 0;
        if (Number.isFinite(holdMs) && holdMs > existing.maxMs) existing.maxMs = holdMs;
      } else if (siteTable.size < getSiteTableCap()) {
        siteTable.set(site, {
          count: 1,
          sumMs: Number.isFinite(holdMs) ? holdMs : 0,
          maxMs: Number.isFinite(holdMs) ? holdMs : 0
        });
      } else {
        siteOverflow++;
      }
    }
  } catch {
    // Rule 1: recording can never disturb the caller. A metrics
    // bug must not surface as a failed transaction.
  }
}

// Site capture can be disabled outright for a deployment that
// wants the histograms with zero allocation on the hot path.
export function isSiteCaptureEnabled() {
  return (process.env.RUNTIME_METRICS_SITE_CAPTURE || "on") !== "off";
}

/**
 * Capture a short call-site label for a slow transaction.
 *
 * The caller passes an Error constructed at the START of the
 * transaction. V8 captures the stack structure at construction
 * but formats it lazily, so building the Error is cheap and the
 * expensive formatting happens here, only for transactions that
 * actually crossed the slow threshold. Reading the stack in a
 * finally block without this marker would be unreliable: the
 * async continuation may no longer carry the originating frame.
 *
 * Returns a "file.js:line" style label with absolute paths and
 * arguments stripped: enough to rank offenders, never enough to
 * leak an argument value or a secret into the metric row.
 */
export function captureCallSite(marker) {
  try {
    const stack = (marker && marker.stack) || new Error().stack || "";
    const lines = stack.split("\n").slice(1);
    for (const raw of lines) {
      const line = String(raw);
      if (line.includes("/db/with-tenant.js")) continue;
      if (line.includes("/services/runtime-metrics.js")) continue;
      if (line.includes("node:internal")) continue;
      const m = line.match(/([A-Za-z0-9._-]+\.m?js):(\d+):\d+/);
      if (m) return `${m[1]}:${m[2]}`;
    }
  } catch {
    // A stack-shape change must never break recording.
  }
  return null;
}

/**
 * Record a transaction that never acquired a connection, i.e.
 * pool.connect() rejected (almost always connectionTimeoutMillis
 * exceeded). This is the exact event that becomes a user-visible
 * 500 under saturation, so it is counted separately from an
 * in-transaction failure and must NOT decrement the open depth:
 * nothing was ever opened.
 */
export function recordAcquireFailure(waitMs) {
  try {
    acquireFailureCount++;
    const ms = Number(waitMs);
    if (Number.isFinite(ms)) ringPush(waitRing, ms);
  } catch {
    // Never disturb the caller's error.
  }
}

// Pool gauge sampling. Called from the interval, not the hot
// path, so a pool read can never be in a request's critical path.
function samplePool() {
  try {
    const g = poolGaugeRef && poolGaugeRef();
    if (!g) return;
    if (Number.isFinite(g.waiting) && g.waiting > poolWaitingMax) poolWaitingMax = g.waiting;
    if (Number.isFinite(g.total) && g.total > poolTotalMax) poolTotalMax = g.total;
  } catch {
    // Pool not loaded yet, or shutting down. Not fatal.
  }
}

// The pool gauge is injected rather than statically imported so
// this module never forces pool.js to load. pool.js decrypts
// connection secrets at import time and must stay under the
// index.js STEP 4 ordering discipline.
let poolGaugeRef = null;
export function setPoolGauge(fn) {
  poolGaugeRef = typeof fn === "function" ? fn : null;
}

// ── Snapshot ─────────────────────────────────────────────────
// Pure read of the current window. Used by the emitter and safe
// to call from a test without any database present.

export function snapshotWindow() {
  // Take a gauge reading before summarizing. Without this a
  // snapshot taken outside the interval (a test, or an on-demand
  // read) would report a poolWaitingMax of zero regardless of
  // actual saturation, because only the interval samples.
  samplePool();

  const holds = ringSnapshot(holdRing);
  const waits = ringSnapshot(waitRing);
  const sortedHolds = Float64Array.from(holds).sort();
  const sortedWaits = Float64Array.from(waits).sort();

  const sites = [...siteTable.entries()]
    .map(([site, s]) => ({
      site,
      count: s.count,
      avgMs: round3(s.sumMs / s.count),
      maxMs: round3(s.maxMs)
    }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 20);

  const loop = loopHistogram
    ? {
        p50: round3(loopHistogram.percentile(50) / 1e6),
        p99: round3(loopHistogram.percentile(99) / 1e6),
        max: round3(loopHistogram.max / 1e6)
      }
    : { p50: null, p99: null, max: null };

  const mem = process.memoryUsage();

  return {
    windowSeconds: Math.round(getMetricsWindowMs() / 1000),
    loopLagP50Ms: loop.p50,
    loopLagP99Ms: loop.p99,
    loopLagMaxMs: loop.max,
    txnCount,
    txnHoldP50Ms: percentile(sortedHolds, 50),
    txnHoldP95Ms: percentile(sortedHolds, 95),
    txnHoldP99Ms: percentile(sortedHolds, 99),
    txnHoldMaxMs: sortedHolds.length ? round3(sortedHolds[sortedHolds.length - 1]) : null,
    txnWaitP99Ms: percentile(sortedWaits, 99),
    txnOpenMax,
    txnErrorCount,
    poolTotal: poolTotalMax,
    poolIdle: (() => {
      try { const g = poolGaugeRef && poolGaugeRef(); return g ? g.idle : null; } catch { return null; }
    })(),
    poolWaitingMax,
    poolMax: (() => {
      try { const g = poolGaugeRef && poolGaugeRef(); return g ? g.max : null; } catch { return null; }
    })(),
    rssMb: round3(mem.rss / 1048576),
    heapUsedMb: round3(mem.heapUsed / 1048576),
    acquireFailureCount,
    detail: { slowSites: sites, siteOverflow, sampleCount: sortedHolds.length }
  };
}

// ── Persistence ──────────────────────────────────────────────
// One INSERT per window, fire-and-forget, never recursive into
// platformLog (which persists through the same pool this module
// is measuring). Failures print to console and are otherwise
// swallowed: an absent runtime_metric table degrades to console
// output rather than a crash loop.

async function persistWindow(snap) {
  if (!isMetricsPersistEnabled()) return;
  try {
    const { query } = await import("../db/pool.js");
    await query(
      `INSERT INTO runtime_metric (
         window_seconds, loop_lag_p50_ms, loop_lag_p99_ms, loop_lag_max_ms,
         txn_count, txn_hold_p50_ms, txn_hold_p95_ms, txn_hold_p99_ms,
         txn_hold_max_ms, txn_wait_p99_ms, txn_open_max, txn_error_count,
         acquire_failure_count, pool_total, pool_idle, pool_waiting_max, pool_max,
         rss_mb, heap_used_mb, detail
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb
       )`,
      [
        snap.windowSeconds, snap.loopLagP50Ms, snap.loopLagP99Ms, snap.loopLagMaxMs,
        snap.txnCount, snap.txnHoldP50Ms, snap.txnHoldP95Ms, snap.txnHoldP99Ms,
        snap.txnHoldMaxMs, snap.txnWaitP99Ms, snap.txnOpenMax, snap.txnErrorCount,
        snap.acquireFailureCount, snap.poolTotal, snap.poolIdle, snap.poolWaitingMax, snap.poolMax,
        snap.rssMb, snap.heapUsedMb, JSON.stringify(snap.detail)
      ]
    );
  } catch (err) {
    console.error(`[runtime-metrics] persistence failed: ${err && err.message}`);
  }
}

/**
 * Prune runtime_metric rows older than the retention window.
 * Runs from this module's own interval rather than the scheduler,
 * so Phase 0 requires no scheduler edit. Returns the row count.
 *
 * NOTE FOR THE OPERATOR: the DDL grants DELETE to the app role
 * explicitly. Without that grant this prune fails silently and
 * the table grows without bound, exactly as platform_log did.
 */
export async function pruneRuntimeMetrics() {
  const days = getMetricsRetentionDays();
  const { query } = await import("../db/pool.js");
  const { rowCount } = await query(
    `DELETE FROM runtime_metric WHERE captured_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  if (rowCount > 0) {
    console.log(`[runtime-metrics] retention pruned ${rowCount} samples older than ${days} days`);
  }
  return rowCount;
}

// ── Lifecycle ────────────────────────────────────────────────

/**
 * Begin sampling. Idempotent: a second call is a no-op, so a
 * double-start during a reload cannot create two intervals.
 * The interval is unref'd so it can never hold the process open.
 */
export function startRuntimeMetrics() {
  if (started) return false;
  started = true;

  try {
    loopHistogram = monitorEventLoopDelay({ resolution: 10 });
    loopHistogram.enable();
  } catch (err) {
    loopHistogram = null;
    console.error(`[runtime-metrics] event loop sampler unavailable: ${err && err.message}`);
  }

  resetWindow();

  const windowMs = getMetricsWindowMs();
  // Sample the pool gauge ten times per window so waitingCount
  // spikes between emits are not missed. A single read at emit
  // time would show zero for a burst that already drained.
  const poolTick = Math.max(1000, Math.floor(windowMs / 10));

  timer = setInterval(() => {
    samplePool();
  }, poolTick);
  if (typeof timer.unref === "function") timer.unref();

  emitTimer = setInterval(() => {
    void emitOnce();
  }, windowMs);
  if (typeof emitTimer.unref === "function") emitTimer.unref();

  console.log(
    `[runtime-metrics] sampling started: window ${Math.round(windowMs / 1000)}s, ` +
    `slow-transaction threshold ${getSlowTransactionMs()}ms, ` +
    `persist ${isMetricsPersistEnabled() ? "on" : "off"}`
  );
  return true;
}

let emitTimer = null;

/**
 * Emit one window: snapshot, persist, reset, and prune on the
 * hour. Exported so a test can drive a window deterministically
 * instead of waiting on wall-clock time.
 */
export async function emitOnce() {
  let snap;
  try {
    samplePool();
    snap = snapshotWindow();
  } catch (err) {
    console.error(`[runtime-metrics] snapshot failed: ${err && err.message}`);
    return null;
  }

  try {
    if (loopHistogram) loopHistogram.reset();
    resetWindow();
  } catch {
    // A reset failure must not stop the next window from starting.
  }

  emitCount++;
  await persistWindow(snap);

  // Prune once per hour of windows, not once per window.
  const windowsPerHour = Math.max(1, Math.round(3600000 / getMetricsWindowMs()));
  if (isMetricsPersistEnabled() && emitCount % windowsPerHour === 0) {
    try {
      await pruneRuntimeMetrics();
    } catch (err) {
      console.error(`[runtime-metrics] prune failed: ${err && err.message}`);
    }
  }

  return snap;
}

/**
 * Stop sampling and release the timers. Safe to call when never
 * started. Exported for tests and for the graceful-shutdown
 * handler that lands in Phase 3.
 */
export function stopRuntimeMetrics() {
  if (timer) { clearInterval(timer); timer = null; }
  if (emitTimer) { clearInterval(emitTimer); emitTimer = null; }
  if (loopHistogram) {
    try { loopHistogram.disable(); } catch { /* already disabled */ }
    loopHistogram = null;
  }
  started = false;
  return true;
}

// Test-only: returns whether sampling is currently active.
export function isRuntimeMetricsStarted() {
  return started;
}

// Test-only: clears all window state without touching timers.
export function resetForTesting() {
  resetWindow();
  emitCount = 0;
  txnOpen = 0;
  txnOpenMax = 0;
}
