// ═══════════════════════════════════════════════════════════════
// spend-recorder.js - the ledger's only writer. One row per vendor
// call, append-only, inside the ambient tenant transaction. A
// recording failure is LOUD (platformLog) but never fails the
// person's generation: metering must not break the product.
// ═══════════════════════════════════════════════════════════════
import { currentClient, currentTenantId } from "../db/with-tenant.js";
import { ensureActivationId, currentActivation, takeKeyProvenance } from "./activation-context.js";
import { platformLog } from "../services/platform-log.js";

export async function recordSpend(evt, deps = {}) {
  try {
    const q = deps.query || ((sql, params) => currentClient().query(sql, params));
    const ctx = currentActivation();
    const activationId = await ensureActivationId(evt.fallbackWorkflow || "compose", deps);
    const prov = evt.provenance || takeKeyProvenance() || { keySource: "tenant", keyFingerprint: "unresolved" };
    const requestType = (ctx && ctx.requestTypeOverride) || evt.requestType;
    const u = evt.usage || {};
    await q(
      `INSERT INTO llm_spend_events
         (tenant_id, activation_id, request_type, provider, model, key_source, key_fingerprint,
          trial_activation_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_estimate_usd, status, source_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [deps.tenantId || currentTenantId(), activationId, requestType, evt.provider, evt.model,
       prov.keySource, prov.keyFingerprint, prov.trialActivationId ?? null,
       toInt(u.promptTokens ?? u.inputTokens), toInt(u.completionTokens ?? u.outputTokens),
       toInt(u.cacheReadTokens), toInt(u.cacheWriteTokens),
       Number.isFinite(evt.costEstimateUsd) ? evt.costEstimateUsd : null,
       evt.status || "ok",
       evt.sourceRef ? JSON.stringify(evt.sourceRef).slice(0, 2048) : null,
       (ctx && ctx.createdBy) || null]
    );
  } catch (err) {
    platformLog("error", "spend_record_failed", { error: err && err.message, provider: evt && evt.provider });
  }
}

function toInt(v) { return Number.isFinite(v) ? Math.trunc(v) : null; }
