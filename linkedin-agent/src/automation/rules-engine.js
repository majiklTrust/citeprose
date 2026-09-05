// ═══════════════════════════════════════════════════════════════
// src/automation/rules-engine.js: the automation decisions (pure)
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. Pure functions: plain data in, a decision out. No
// database, no clock of its own, no environment. The loops gather
// the inputs and act on the outputs; the functional suites drive
// these directly with representative data and no server, which is
// the point of keeping them pure.
//
// This delivery ships the publishing decision. The generation
// decision (slots, cadence rules, the default plan) lands with the
// rules delivery and joins it here.
//
// evaluatePublishing(input)
//   input:
//     now                Date (or anything Date can parse)
//     mode, paused       the tenant's automation state
//     reviewWindowHours  non-negative integer
//     queue              rows in pending_approval:
//                        { id, queuedAt, content, wireLength,
//                          publishTarget, credentials: { ok, code, reason } }
//     cadence            the canPostNow() result { allowed, reason, ... }
//     wireMax            the LinkedIn commentary limit
//   returns one of:
//     { action: "hold", reasonCode, reason, nextDueAt, skipped }
//     { action: "publish", postId, reasonCode: "queue_due", reason, skipped }
//
// Order of the checks, first match wins: the gate (pause, mode),
// an empty queue, the cadence floor, then the queue oldest first:
// the connection for that post's target, the review window (which
// holds, because a queue walked oldest first cannot have an older
// row that is due when this one is not), empty content (skip), the
// wire length (skip). A skipped row is named so the loop can report
// it once; a row that fails the window holds the whole sweep.
//
// Everything malformed fails closed: a queue that is not an array,
// a row without an id or a parseable queuedAt, a window that is not
// a non-negative integer, a cadence that is not an object, all
// produce a hold, never a publish. The engine never throws on input
// shape and never mutates its input.
// ═══════════════════════════════════════════════════════════════

import { automationGate } from "./automation-mode.js";

const HOUR_MS = 3600 * 1000;

function hold(reasonCode, reason, extra = {}) {
  return { action: "hold", reasonCode, reason, nextDueAt: null, skipped: [], ...extra };
}

function toTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : NaN;
  if (typeof value === "string" || typeof value === "number") {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}

function soundRow(row) {
  if (!row || typeof row !== "object") return null;
  const id = row.id;
  const idOk = (typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && /^\d+$/.test(id));
  const queuedAtMs = toTime(row.queuedAt);
  if (!idOk || !Number.isFinite(queuedAtMs)) return null;
  return { row, id, queuedAtMs };
}

export function evaluatePublishing(input) {
  const i = input && typeof input === "object" ? input : {};
  const gate = automationGate({ loop: "publishing", mode: i.mode, paused: i.paused });
  if (!gate.allowed) return hold(gate.reasonCode, gate.reasonCode === "paused" ? "the agent is paused" : "publishing is not automated in this automation state");

  const nowMs = toTime(i.now);
  if (!Number.isFinite(nowMs)) return hold("invalid_input", "the sweep clock is not a valid time");
  const window = Number.isInteger(i.reviewWindowHours) && i.reviewWindowHours >= 0 ? i.reviewWindowHours : null;
  if (window === null) return hold("invalid_input", "the review window is not a non-negative integer");
  const wireMax = Number.isInteger(i.wireMax) && i.wireMax > 0 ? i.wireMax : null;
  if (wireMax === null) return hold("invalid_input", "the commentary limit is not a positive integer");

  if (!Array.isArray(i.queue)) return hold("invalid_input", "the queue is not a list");
  const sound = [];
  const skipped = [];
  for (const raw of i.queue) {
    const s = soundRow(raw);
    if (s) sound.push(s);
    else skipped.push({ postId: raw && typeof raw === "object" && raw.id !== undefined ? raw.id : null, reasonCode: "invalid_row" });
  }
  if (i.queue.length === 0) return hold("queue_empty", "no post is awaiting review");

  const cadence = i.cadence && typeof i.cadence === "object" ? i.cadence : null;
  if (!cadence || cadence.allowed !== true) {
    return hold("cadence", cadence && typeof cadence.reason === "string" ? cadence.reason : "the cadence floor does not allow a publish now",
      { nextDueAt: cadence && typeof cadence.nextWindowOpens === "string" && cadence.nextWindowOpens !== "now" ? cadence.nextWindowOpens : null });
  }

  sound.sort((a, b) => a.queuedAtMs - b.queuedAtMs || compareIds(a.id, b.id));
  for (const { row, id, queuedAtMs } of sound) {
    const creds = row.credentials;
    if (!creds || typeof creds !== "object" || creds.ok !== true) {
      return hold("linkedin_not_connected",
        creds && typeof creds === "object" && typeof creds.reason === "string" ? creds.reason : "LinkedIn is not connected for this post's destination",
        { skipped, blockedPostId: id, code: creds && typeof creds === "object" && typeof creds.code === "string" ? creds.code : null });
    }
    const dueMs = queuedAtMs + window * HOUR_MS;
    if (dueMs > nowMs) {
      // A window so large the due time leaves the calendar (an
      // absurd stored value) still holds; it just has no date.
      const due = new Date(dueMs);
      return hold("review_window", `the oldest queued post has been waiting ${Math.floor((nowMs - queuedAtMs) / HOUR_MS)}h of the ${window}h review window`,
        { nextDueAt: Number.isFinite(due.getTime()) ? due.toISOString() : null, skipped, blockedPostId: id, queuedForHours: Math.floor((nowMs - queuedAtMs) / HOUR_MS) });
    }
    if (typeof row.content !== "string" || row.content.trim() === "") {
      skipped.push({ postId: id, reasonCode: "empty_content" });
      continue;
    }
    if (!(typeof row.wireLength === "number" && Number.isFinite(row.wireLength) && row.wireLength >= 0)) {
      skipped.push({ postId: id, reasonCode: "invalid_row" });
      continue;
    }
    if (row.wireLength > wireMax) {
      skipped.push({ postId: id, reasonCode: "too_long", wireLength: row.wireLength, limit: wireMax });
      continue;
    }
    return {
      action: "publish", postId: id, reasonCode: "queue_due",
      reason: `the oldest publishable queued post has waited ${Math.floor((nowMs - queuedAtMs) / HOUR_MS)}h of the ${window}h review window`,
      queuedForHours: Math.floor((nowMs - queuedAtMs) / HOUR_MS), skipped
    };
  }
  return hold("queue_all_skipped", "every queued post was skipped for a reason the trail names", { skipped });
}

function compareIds(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
