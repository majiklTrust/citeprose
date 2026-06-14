// ═══════════════════════════════════════════════════════════════
// src/services/llm-trace.js — Phase 1 backend-call observability
// ═══════════════════════════════════════════════════════════════
// Pure, zero-import, console-silent. Helpers for the four backend
// LLM call sites (web_search, corroboration, main_post_generation,
// quality_check):
//
//   traceEnabled(v)
//     LLM_TRACE gate for the DEBUG payload dumps. Trimmed strict
//     "1" only — every other value fails CLOSED so a typo can
//     never dump prompt content. INFO markers are NEVER gated.
//
//   buildLlmRequestInfo(step, stepIndex, params, extra)
//     The always-on INFO payload: step, stepIndex ("N of 4"),
//     model, promptChars (sum of message content lengths),
//     systemChars (only when a system prompt is present), plus
//     caller extras (cycleId, topicId, angle, ...). Junk-safe:
//     malformed params yield promptChars 0, never a throw —
//     observability must not be able to crash a generation.
//
//   buildLlmPayloadDebug(step, params, cycleId)
//     Wraps the EXACT request object (same reference, never
//     copied or mutated) so the DEBUG log provably shows the
//     bytes sent: model, max_tokens, system, tools, and the
//     fully-rendered messages — all {{CHIP}} placeholders were
//     already resolved upstream by renderPrompt, so the dump
//     contains finished prompt text, never placeholders.
//
// Phase 2 (deferred by explicit decision): composition/provenance
// map, per-cycle lineage summary, size cap + redaction. Phase 1
// DEBUG is therefore unbounded by design.
// ═══════════════════════════════════════════════════════════════

export function traceEnabled(value) {
  return typeof value === "string" && value.trim() === "1";
}

function charsOf(x) {
  return typeof x === "string" ? x.length : 0;
}

export function buildLlmRequestInfo(step, stepIndex, params, extra) {
  const p = params && typeof params === "object" ? params : {};
  const msgs = Array.isArray(p.messages) ? p.messages : [];
  let promptChars = 0;
  for (const m of msgs) {
    if (m && typeof m === "object") promptChars += charsOf(m.content);
  }
  const info = {
    ...(extra && typeof extra === "object" ? extra : {}),
    step,
    stepIndex,
    model: typeof p.model === "string" ? p.model : null,
    promptChars
  };
  if (typeof p.system === "string") {
    info.systemChars = p.system.length;
  }
  return info;
}

export function buildLlmPayloadDebug(step, params, cycleId) {
  return { cycleId, step, request: params };
}
