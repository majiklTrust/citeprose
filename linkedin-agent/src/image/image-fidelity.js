// ═══════════════════════════════════════════════════════════════
// src/image/image-fidelity.js - Phase 2 verified-metric lock
// ═══════════════════════════════════════════════════════════════
// Ensures a derived image brief carries no fabricated statistics.
// Any digit-number in the brief must match a VERIFIED metric value
// from the tenant's metric store; otherwise the brief is a fidelity
// violation and the caller (generate-from-brief) rejects it rather
// than rendering an unverified number into an image.
//
// It REUSES the text-side verifier (verifyMetricFidelity,
// extractNumericTokens) from metric-content.js rather than reinventing
// numeric checking, so the image lock and the post lock agree, to the
// digit, on what "verified" means. Those functions are pure.
//
// The metric store (getMetricsForTopic) is RLS-scoped, so it is
// lazy-imported (pg-free module import) and injectable (unit-testable).
// It is the SAME store, keyed by the SAME metric_key, that the post
// generator reads, and it is queried by the grounding topic the image
// brief already carries.
//
// Fail-closed: with no verified metrics (no topic, none defined, or a
// store error), any number in the brief reads as unverified and the
// lock fails. A brief with no numbers passes trivially, which is what
// the image_brief template asks the model to produce.
// ═══════════════════════════════════════════════════════════════

import { verifyMetricFidelity, extractNumericTokens } from "../services/metric-content.js";
import { platformLog } from "../services/platform-log.js";

function resolveDeps(deps) {
  return {
    getMetrics: deps.getMetrics ||
      (async (topicRef) => (await import("../services/metric-store.js")).getMetricsForTopic(topicRef))
  };
}

// Build the metricKey -> metric Map the verifier expects, from the
// tenant's verified metrics for a topic. Requires tenant context.
// Empty Map for no topic / no metrics; a store error degrades to empty
// (fail-closed).
export async function loadVerifiedMetrics(topicRef, deps = {}) {
  const d = resolveDeps(deps);
  const byKey = new Map();
  if (topicRef === null || topicRef === undefined || topicRef === "") return byKey;
  try {
    const groups = await d.getMetrics(topicRef);
    for (const grp of (groups || [])) {
      for (const mt of (grp && grp.metrics ? grp.metrics : [])) {
        if (mt && typeof mt.metricKey === "string") byKey.set(mt.metricKey, mt);
      }
    }
  } catch (err) {
    platformLog("warn", "image_fidelity_metric_fetch_failed", { error: err.message });
    byKey.clear(); // fail-closed: no verified numbers means any number is unverified
  }
  return byKey;
}

// Check a brief against verified metrics using the shared strict
// verifier. Returns a frozen verdict; never throws on content.
//
// Metric tokens are a TEXT-pipeline mechanism: the post generator
// substitutes {{METRIC_key}} with the verified value before anything
// ships. The image path never substitutes, so ANY token left in a
// brief, known or not, would be drawn literally into the image.
// Tokens are enumerated by running the shared verifier against an
// EMPTY metric set (every token reports as unknown), so this module
// still invents no token or number parsing of its own.
export function checkBriefFidelity(brief, byKey, options = {}) {
  const text = typeof brief === "string" ? brief : "";
  const verdict = verifyMetricFidelity(text, byKey, {
    strict: true,
    allowedNumbers: Array.isArray(options.allowedNumbers) ? options.allowedNumbers : []
  });
  const tokenScan = verifyMetricFidelity(text, new Map(), {});
  const metricTokens = tokenScan.unknownTokens;
  return Object.freeze({
    ok: verdict.ok && metricTokens.length === 0,
    unknownTokens: verdict.unknownTokens,
    metricTokens,
    unverifiedNumbers: verdict.unverifiedNumbers,
    numbers: extractNumericTokens(text)
  });
}

// Load the topic's verified metrics and check the brief in one call.
// The step-3 wiring calls this before render() and rejects a non-ok
// verdict. context: { topicRef | sourceTopicId, allowedNumbers }.
export async function lockBrief(brief, context = {}, deps = {}) {
  const topicRef = context.topicRef != null ? context.topicRef
    : (context.sourceTopicId != null ? context.sourceTopicId : null);
  const byKey = await loadVerifiedMetrics(topicRef, deps);
  const verdict = checkBriefFidelity(brief, byKey, { allowedNumbers: context.allowedNumbers });
  platformLog(verdict.ok ? "info" : "warn", "image_fidelity_checked", {
    ok: verdict.ok,
    unverified: verdict.unverifiedNumbers.length,
    unknownTokens: verdict.unknownTokens.length,
    metricTokens: verdict.metricTokens.length,
    metrics: byKey.size
  });
  return Object.freeze({
    ok: verdict.ok,
    unknownTokens: verdict.unknownTokens,
    metricTokens: verdict.metricTokens,
    unverifiedNumbers: verdict.unverifiedNumbers,
    numbers: verdict.numbers,
    metricsAvailable: byKey.size
  });
}
