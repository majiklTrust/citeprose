// ═══════════════════════════════════════════════════════════════
// src/services/image-pricing.js - versioned vendor rates (step 1)
// ═══════════════════════════════════════════════════════════════
// Replaces the hardcoded pricing constants that lived in
// model-profiles.js. Rates and exact per-image pre-spend charges are
// PLATFORM data (41-image-model-pricing.sql), versioned by
// effective_at: a correction is a new row, and reads pick the latest
// row at or before now.
//
// FAIL-CLOSED FOR SPEND: a missing pre-spend row resolves to null and
// the render pipeline refuses to spend unpriced (PRICING_UNAVAILABLE)
// rather than estimating zero, because a zero estimate would walk
// straight through the budget gate. 'auto' size or quality resolves
// to the WORST-CASE priced row for the model, so the gate always
// charges conservatively.
//
// DB access is lazy (pg-free import) and injectable (unit-testable).
// ═══════════════════════════════════════════════════════════════

const rateCache = new Map();
const preSpendCache = new Map();
export function resetPricingCache() { rateCache.clear(); preSpendCache.clear(); }

function resolveDeps(deps) {
  return {
    query: deps.query || (async (sql, params) => (await import("../db/pool.js")).query(sql, params))
  };
}
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Latest effective rates for (provider, model), or null when unpriced.
export async function resolveModelRates(provider, model, deps = {}) {
  const key = `${provider}|${model}`;
  if (rateCache.has(key)) return rateCache.get(key);
  const d = resolveDeps(deps);
  const r = await d.query(
    `SELECT text_input_per_mtok, image_input_per_mtok, image_output_per_mtok, cached_input_per_mtok
     FROM image_model_pricing
     WHERE provider = $1 AND model = $2 AND effective_at <= now()
     ORDER BY effective_at DESC LIMIT 1`, [provider, model]);
  const row = r.rows && r.rows[0];
  const rates = row ? Object.freeze({
    textInputPerMTokUsd: toNum(row.text_input_per_mtok),
    imageInputPerMTokUsd: toNum(row.image_input_per_mtok),
    imageOutputPerMTokUsd: toNum(row.image_output_per_mtok),
    cachedInputPerMTokUsd: toNum(row.cached_input_per_mtok)
  }) : null;
  rateCache.set(key, rates);
  return rates;
}

// Exact per-image pre-spend for (provider, model, size, quality).
// 'auto' on either axis resolves to the model's worst-case priced
// row. Returns null when no row prices the request: the caller MUST
// refuse to spend.
export async function resolvePreSpendUsd(provider, model, size, quality, count, deps = {}) {
  const d = resolveDeps(deps);
  const n = Number.isInteger(count) && count > 0 ? count : 1;
  const wantAuto = size === "auto" || quality === "auto" || size == null || quality == null;
  const key = `${provider}|${model}|${wantAuto ? "auto" : size + "|" + quality}`;
  let per = preSpendCache.has(key) ? preSpendCache.get(key) : undefined;
  if (per === undefined) {
    let r;
    if (wantAuto) {
      r = await d.query(
        `SELECT usd_per_image FROM image_model_prespend
         WHERE provider = $1 AND model = $2 AND effective_at <= now()
         ORDER BY usd_per_image DESC LIMIT 1`, [provider, model]);      // worst case
    } else {
      r = await d.query(
        `SELECT usd_per_image FROM image_model_prespend
         WHERE provider = $1 AND model = $2 AND size = $3 AND quality = $4 AND effective_at <= now()
         ORDER BY effective_at DESC LIMIT 1`, [provider, model, size, quality]);
    }
    const row = r.rows && r.rows[0];
    per = row ? toNum(row.usd_per_image) : null;
    preSpendCache.set(key, per);
  }
  if (per === null) return null;
  return Math.round(per * n * 1e6) / 1e6;
}

// Three-category actual cost from usage. Uses the text/image input
// split when the adapter provides it; otherwise all input tokens bill
// at the text rate (the conservative direction only when text is the
// cheaper rate, which the caller does not assume: this is
// reconciliation data, never a gate). Returns null when rates or
// token counts are missing.
export function computeActualCostUsd(rates, usage) {
  if (!rates || !usage) return null;
  const out = toNum(usage.outputTokens);
  if (out === null || out < 0) return null;
  const textIn = toNum(usage.inputTextTokens);
  const imageIn = toNum(usage.inputImageTokens);
  let usd;
  if (textIn !== null && imageIn !== null && textIn >= 0 && imageIn >= 0) {
    usd = (textIn / 1e6) * rates.textInputPerMTokUsd
        + (imageIn / 1e6) * rates.imageInputPerMTokUsd
        + (out / 1e6) * rates.imageOutputPerMTokUsd;
  } else {
    const allIn = toNum(usage.inputTokens);
    if (allIn === null || allIn < 0) return null;
    usd = (allIn / 1e6) * rates.textInputPerMTokUsd
        + (out / 1e6) * rates.imageOutputPerMTokUsd;
  }
  return Math.round(usd * 1e6) / 1e6;
}
