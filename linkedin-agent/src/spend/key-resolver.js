// ═══════════════════════════════════════════════════════════════
// key-resolver.js - chain-of-responsibility for WHOSE key pays:
// trial (precedence when granted), tenant vault, platform env.
// Returns the same plain string the client's getApiKey contract
// promises; provenance travels through the activation context so
// the client stays ignorant of all of this. An ACTIVE grant whose
// window or caps refuse produces a TYPED error: never a silent
// fallback that converts platform money into tenant money.
// ═══════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import { currentTenantId } from "../db/with-tenant.js";
import { setKeyProvenance } from "./activation-context.js";
import { resolveActiveTrial } from "./trial-store.js";

function fp(material) {
  return createHash("sha256").update(String(material)).digest("hex").slice(0, 16);
}

export class TrialRefusedError extends Error {
  constructor(code, providerId) {
    super(code === "TRIAL_EXPIRED"
      ? `The platform trial for ${providerId} has ended; no key is available for this provider until it is renewed or removed.`
      : code === "TRIAL_REVOKED"
        ? `The platform trial for ${providerId} was deactivated; no key is available for this provider.`
        : `The platform trial for ${providerId} has reached its spend cap; no key is available for this provider.`);
    this.code = code;
    this.providerId = providerId;
  }
}

export async function resolveLlmKey(providerId, deps = {}) {
  const tenantId = deps.tenantId || currentTenantId();
  // F3/F5 (2.5.57): a trial REFUSAL is typed and final; trial
  // INFRASTRUCTURE failure (DDL not yet applied, connectivity,
  // ciphertext under a rotated secret) must never take generation
  // down for a visibility feature. It logs loudly and the chain
  // continues to the tenant's own key.
  let trial = null;
  try {
    trial = await (deps.resolveActiveTrial || resolveActiveTrial)(tenantId, providerId, deps);
  } catch (infraErr) {
    const { platformLog } = await import("../services/platform-log.js");
    platformLog("error", "trial_resolution_unavailable", { providerId, error: infraErr && infraErr.message });
    trial = null;
  }
  if (trial && trial.refused) throw new TrialRefusedError(trial.code, providerId);
  if (trial) {
    setKeyProvenance({ keySource: "trial", keyFingerprint: trial.keyFingerprint, trialActivationId: trial.trialActivationId });
    return trial.apiKey;
  }
  const getTenantKey = deps.getTenantKey || (async (p) => {
    const { getLlmApiKey } = await import("../tenant/credential-store.js");
    return getLlmApiKey(p);
  });
  // F4 (2.5.57): a MISSING tenant credential is a normal chain step,
  // not an error; the platform fallback must stay reachable. Other
  // errors (decrypt failure on a stored key) still propagate.
  let tenantKey = null;
  try {
    tenantKey = await getTenantKey(providerId);
  } catch (credErr) {
    if (!(credErr && /Credential not found/.test(credErr.message || ""))) throw credErr;
  }
  if (typeof tenantKey === "string" && tenantKey.length > 0) {
    setKeyProvenance({ keySource: "tenant", keyFingerprint: fp(tenantKey) });
    return tenantKey;
  }
  const env = deps.env || process.env;
  if (providerId === "anthropic" && typeof env.PLATFORM_ANTHROPIC_API_KEY === "string" && env.PLATFORM_ANTHROPIC_API_KEY.length > 0) {
    setKeyProvenance({ keySource: "platform", keyFingerprint: fp(env.PLATFORM_ANTHROPIC_API_KEY) });
    return env.PLATFORM_ANTHROPIC_API_KEY;
  }
  return null;
}
