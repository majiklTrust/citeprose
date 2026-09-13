// ═══════════════════════════════════════════════════════════════
// src/automation/generation-run.js: the generation claim
// ═══════════════════════════════════════════════════════════════
// 4.25111.94. One generation cycle per tenant at a time, across
// every trigger and every application instance, with the state of
// the run in the database and nowhere else.
//
// Why. The cycle spends minutes on Model Providers. Until now it had
// no claim: the cron tick, the Force Cycle button and a second
// instance's cron could each start it for the same tenant at the
// same moment (double spend, two queued posts), and the Force Cycle
// route held its HTTP connection for the whole cycle. The batch
// publisher solved the same problem for publishing with a claim
// committed BEFORE the external call (posts.status = 'publishing'
// under FOR UPDATE SKIP LOCKED, batch-publisher.js). This module is
// that discipline for generation, on its own table (DDL 50.0):
//
//   claim    INSERT one generation_runs row. The partial unique index
//            (one row per tenant with finished_at IS NULL) is the
//            lock; PostgreSQL enforces it for every instance. A
//            losing claimant gets no row back and reads the winner's
//            row to say who holds it. The caller COMMITS the claim
//            before doing any work (withTenant commits at its end;
//            the workflow envelope commits at yieldDb).
//   finish   UPDATE finished_at and the decision. Called in success
//            and in failure, so the lock is released by the same
//            code path whatever the cycle did.
//   stale    A row left open longer than the stale window (the
//            process died, was redeployed, or lost its database)
//            is closed by the NEXT claimant as 'abandoned', on the
//            row, with the facts, and the claim proceeds. Recovery
//            needs no operator and no process memory; the window is
//            generous next to the longest legitimate cycle.
//
// Concurrency, stated. Two claimants racing: both INSERT; the second
// waits on the first's uncommitted row only for the instant until it
// commits, then finds the conflict and backs off. Two claimants
// racing to abandon the same stale row: the UPDATE carries
// "AND finished_at IS NULL", so exactly one succeeds; the other
// re-reads and finds a fresh open row (the winner's) and backs off.
// READ COMMITTED is enough for all of this; nothing here needs
// SERIALIZABLE or an advisory lock (which would not survive the
// leased envelope's per-crossing connection surrender anyway).
//
// Retention. finish() prunes this tenant's rows older than
// GENERATION_RUN_RETENTION_DAYS (default 90). RLS is forced on the
// table, so the prune belongs inside a tenant scope; there is no
// platform-level sweep to forget.
//
// Every function must be called inside a tenant scope (withTenant or
// the workflow envelope) and reaches the database through
// currentClient(), like every other tenant-scoped module.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { currentClient } from "../db/with-tenant.js";

export const RUN_TRIGGERS = Object.freeze(["cron", "force_cycle"]);

// Module-local resolvers, the house pattern for a single consumer
// (batch-publisher.js resolves BATCH_PUBLISH_INTERVAL_MINUTES the
// same way). Read at every call, never cached, invalid falls back.
function intFromEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
// A run older than this with no finish is treated as abandoned. The
// longest legitimate cycle is bounded by the Model Provider timeouts
// (research plus generation plus one quality retry); 45 minutes is
// several times that.
export function getStaleRunMinutes() {
  return intFromEnv("GENERATION_RUN_STALE_MINUTES", 45, 5, 24 * 60);
}
export function getRunRetentionDays() {
  return intFromEnv("GENERATION_RUN_RETENTION_DAYS", 90, 1, 3650);
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
function safeTopic(topicId) {
  return typeof topicId === "string" && SLUG_RE.test(topicId) ? topicId : null;
}
function instanceLabel() {
  return `${hostname()}:${process.pid}`.slice(0, 128);
}

function db() {
  const c = currentClient();
  if (!c) throw new Error("generation-run: no tenant scope");
  return c;
}

function rowToRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    trigger: row.trigger,
    requestedBy: row.requested_by || null,
    topicId: row.topic_id || null,
    instance: row.instance || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    outcome: row.outcome || null
  };
}

const RUN_COLUMNS = "run_id, trigger, requested_by, topic_id, instance, started_at, finished_at, outcome";

async function insertClaim(c, { trigger, requestedBy, topicId }) {
  const runId = randomUUID();
  const { rows } = await c.query(
    `INSERT INTO generation_runs (tenant_id, run_id, trigger, requested_by, topic_id, instance)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) WHERE finished_at IS NULL DO NOTHING
     RETURNING ${RUN_COLUMNS}`,
    [runId, trigger, requestedBy, safeTopic(topicId), instanceLabel()]
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

async function readOpenRun(c) {
  const { rows } = await c.query(
    `SELECT ${RUN_COLUMNS} FROM generation_runs
      WHERE tenant_id = current_tenant_id() AND finished_at IS NULL
      LIMIT 1`
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

// Closes a stale open run. Returns true when THIS call closed it.
async function abandonRun(c, run, staleMinutes) {
  const outcome = {
    action: "abandoned",
    reasonCode: "stale_run",
    reason: `no finish after ${staleMinutes} minutes; closed by the next claimant`,
    abandonedBy: instanceLabel()
  };
  const { rowCount } = await c.query(
    `UPDATE generation_runs
        SET finished_at = now(), outcome = $2::jsonb
      WHERE tenant_id = current_tenant_id() AND run_id = $1 AND finished_at IS NULL`,
    [run.runId, JSON.stringify(outcome)]
  );
  return rowCount === 1;
}

// { claimed: true, run } or { claimed: false, activeRun }. Never
// runs the cycle; never throws for a lost race (only for a database
// failure, which the caller's envelope reports).
export async function claimGenerationRun({ trigger, requestedBy = null, topicId = null }) {
  if (!RUN_TRIGGERS.includes(trigger)) throw new Error(`generation-run: unknown trigger ${String(trigger)}`);
  const c = db();
  const first = await insertClaim(c, { trigger, requestedBy, topicId });
  if (first) return { claimed: true, run: first, abandoned: null };

  const open = await readOpenRun(c);
  if (!open) {
    // The holder finished between our INSERT and our read. One more
    // attempt; a second loss is a live competitor.
    const second = await insertClaim(c, { trigger, requestedBy, topicId });
    if (second) return { claimed: true, run: second, abandoned: null };
    return { claimed: false, activeRun: await readOpenRun(c), abandoned: null };
  }

  const staleMinutes = getStaleRunMinutes();
  const ageMs = Date.now() - new Date(open.startedAt).getTime();
  if (ageMs < staleMinutes * 60 * 1000) {
    return { claimed: false, activeRun: open, abandoned: null };
  }
  const closedHere = await abandonRun(c, open, staleMinutes);
  const retry = await insertClaim(c, { trigger, requestedBy, topicId });
  if (retry) return { claimed: true, run: retry, abandoned: closedHere ? open : null };
  return { claimed: false, activeRun: await readOpenRun(c), abandoned: closedHere ? open : null };
}

// Records the decision and releases the claim. The outcome is the
// loop's decision object (or a failure record); it is stored as
// given, bounded by the column check, so a caller passes facts, not
// prose. Prunes this tenant's finished rows past retention.
export async function finishGenerationRun(runId, outcome) {
  const c = db();
  const { rowCount } = await c.query(
    `UPDATE generation_runs
        SET finished_at = now(), outcome = $2::jsonb
      WHERE tenant_id = current_tenant_id() AND run_id = $1 AND finished_at IS NULL`,
    [runId, JSON.stringify(boundedOutcome(outcome))]
  );
  await c.query(
    `DELETE FROM generation_runs
      WHERE tenant_id = current_tenant_id()
        AND finished_at IS NOT NULL
        AND finished_at < now() - ($1 || ' days')::interval`,
    [String(getRunRetentionDays())]
  );
  return rowCount === 1;
}

// Keeps the decision's identifying fields and truncates free text so
// the row check (4096 bytes) can never refuse a legitimate finish.
function boundedOutcome(outcome) {
  const o = outcome && typeof outcome === "object" ? outcome : { action: "unknown" };
  const out = {};
  for (const k of ["action", "reasonCode", "postId", "cycleId", "topicId"]) {
    if (o[k] !== undefined && o[k] !== null) out[k] = typeof o[k] === "object" ? String(o[k]) : o[k];
  }
  if (typeof o.reason === "string") out.reason = o.reason.slice(0, 1024);
  if (typeof o.error === "string") out.error = o.error.slice(0, 1024);
  return out;
}

// For status payloads: the open run (if any) and the newest finished
// one. Read-only; never throws for an empty table.
export async function readGenerationRuns() {
  const c = db();
  const { rows } = await c.query(
    `SELECT ${RUN_COLUMNS} FROM generation_runs
      WHERE tenant_id = current_tenant_id()
      ORDER BY (finished_at IS NULL) DESC, started_at DESC
      LIMIT 2`
  );
  const runs = rows.map(rowToRun);
  const activeRun = runs.find((r) => r.finishedAt === null) || null;
  const lastRun = runs.find((r) => r.finishedAt !== null) || null;
  return { activeRun, lastRun };
}
