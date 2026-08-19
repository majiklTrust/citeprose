// =================================================================
// src/services/generation-trace.js - pipeline observation frame
// =================================================================
// A request scoped AsyncLocalStorage frame that lets an OBSERVER
// watch a generation run without changing how that run is
// sequenced. The pipeline keeps ownership of its own order; it
// simply announces what it assembled at each boundary.
//
// Two things ride the frame:
//
//   trace   a collector the pipeline pushes named stage records
//           into. Recording NEVER throws and never awaits, so the
//           collector cannot become the failure it is observing.
//
//   vendor  an OPTIONAL substitute for the vendor call. When
//           present, the pipeline hands its fully assembled request
//           to this object instead of the network. Everything above
//           the wire (prompt assembly, parsing, scoring, gates) runs
//           for real. When absent, the pipeline calls the vendor
//           exactly as it always has.
//
// When no frame is ambient, every accessor returns null and the
// pipeline is byte for byte the production path. Production
// requests never enter this context.
//
// Zero imports beyond node:async_hooks, so this can be imported
// anywhere without creating a cycle.
//
// The records deliberately contain assembled prompts and vendor
// responses; that visibility is the entire point. They are held in
// request memory only. They are NEVER written to the database and
// NEVER passed to platformLog.
// =================================================================
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

// 200k chars per value. A memory guard, not censorship: the clamp
// states how much it dropped so a truncated value can never be
// mistaken for a complete one.
const STRING_CLAMP = 200000;

function clamp(value) {
  if (typeof value === "string" && value.length > STRING_CLAMP) {
    return value.slice(0, STRING_CLAMP) + `\n[trace clamp: ${value.length - STRING_CLAMP} more chars]`;
  }
  if (Array.isArray(value)) return value.map(clamp);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clamp(value[key]);
    return out;
  }
  return value;
}

export function createGenerationTrace() {
  const startedAt = Date.now();
  const stages = [];
  return {
    stage(name, data) {
      try {
        stages.push({
          id: String(name),
          atMs: Date.now() - startedAt,
          data: clamp(data === undefined ? null : data)
        });
      } catch {
        // Observation must never break the run. Record that we could
        // not observe, rather than losing the stage silently.
        try {
          stages.push({ id: String(name), atMs: Date.now() - startedAt, data: "[untraceable value]" });
        } catch { /* give up quietly */ }
      }
    },
    toJSON() {
      return { startedAtEpochMs: startedAt, totalMs: Date.now() - startedAt, stages };
    }
  };
}

export function runWithGenerationTrace(frame, fn) {
  return als.run(Object.freeze({ ...(frame || {}) }), fn);
}

// The collector, or null in production.
export function generationTrace() {
  const frame = als.getStore();
  return (frame && frame.trace) || null;
}

// The vendor substitute, or null when the run should call the real
// vendor. Its presence is also what marks a run as observed, which
// is how the pipeline knows to skip inter-call rate limit cooldowns
// that exist only to pace real vendor traffic.
export function generationVendor() {
  const frame = als.getStore();
  return (frame && frame.vendor) || null;
}
