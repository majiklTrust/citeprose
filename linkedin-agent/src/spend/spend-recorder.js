// ═══════════════════════════════════════════════════════════════
// spend-recorder.js - the ledger's only writer. One row per Model
// Provider call, append-only, in its OWN short transaction. A
// recording failure is LOUD (platformLog) but never fails the
// person's generation: metering must not break the product.
//
// 4.25111.20: the Generation Lab invariant lives HERE, at the one
// seam every row passes through, not at the call sites. When the
// ambient lab frame is present the row is attributed to the
// platform: key_source 'platform', the platform key's fingerprint
// from the frame, workflow 'generation_lab'. Ruling 2026-08-24:
// real spend is always recorded; a Lab run's rows (and its
// activation row) deliberately SURVIVE the run's rollback, because
// the money left the account whether or not the post was kept.
// No caller can mis-file lab spend against a tenant, and deleting
// a call-site gate can never reintroduce the leak, because the
// attribution decision is made where the row is written.
// ═══════════════════════════════════════════════════════════════
import { currentClient, currentTenantId } from "../db/with-tenant.js";
import { ensureActivationId, currentActivation, takeKeyProvenance } from "./activation-context.js";
import { labRun } from "../services/generation-trace.js";
import { platformLog } from "../services/platform-log.js";

export async function recordSpend(evt, deps = {}) {
  try {
    const ctx = currentActivation();
    // F1 (2.5.57): the ledger writes in its OWN short transaction,
    // never the caller's. Money already spent at the Model Provider must
    // survive a caller rollback; a ledger row that can vanish with
    // someone else's transaction is the fail-open class again.
    if (deps.query) {
      return await writeSpend(evt, ctx, deps.query, deps);
    }
    const tenantId = deps.tenantId || currentTenantId();
    const { withTenant } = await import("../db/with-tenant.js");
    return await withTenant(tenantId, async (client) =>
      writeSpend(evt, ctx, (sql, params) => client.query(sql, params), { ...deps, tenantId })
    );
  } catch (err) {
    platformLog("error", "spend_record_failed", { error: err && err.message, provider: evt && evt.provider });
  }
}

async function writeSpend(evt, ctx, q, deps) {
  {
    // The lab seam. Frame present means this call ran under the
    // Generation Lab: platform money, platform attribution, no
    // matter what the caller passed. takeKeyProvenance() is still
    // consumed under the frame so a resolver-set provenance can
    // never linger and mislabel the NEXT call on this context.
    const lab = labRun();
    if (lab) takeKeyProvenance();
    const activationId = await ensureActivationId(
      lab ? "generation_lab" : (evt.fallbackWorkflow || "compose"),
      { ...deps, query: q }
    );
    const prov = lab
      ? { keySource: "platform", keyFingerprint: lab.keyFingerprint || "unresolved" }
      : (evt.provenance || takeKeyProvenance() || { keySource: "tenant", keyFingerprint: "unresolved" });
    const requestType = (ctx && ctx.requestTypeOverride) || evt.requestType;
    const u = evt.usage || {};
    const sourceRef = lab ? { ...(evt.sourceRef || {}), lab: true } : evt.sourceRef;
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
       sourceRef ? JSON.stringify(sourceRef).slice(0, 2048) : null,
       (ctx && ctx.createdBy) || null]
    );
  }
}

function toInt(v) { return Number.isFinite(v) ? Math.trunc(v) : null; }
