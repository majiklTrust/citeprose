// ═══════════════════════════════════════════════════════════════
// activation-context.js - the llm-activation-workflow-lifecycle
// carried on AsyncLocalStorage, mirroring the tenant context. No
// function signature anywhere changes to thread it; the resolver
// and the recorder rendezvous here without the client knowing
// either exists.
// ═══════════════════════════════════════════════════════════════
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { currentClient, currentTenantId } from "../db/with-tenant.js";

const store = new AsyncLocalStorage();

export function runWithActivation(ctx, fn) {
  // ctx: { id?, workflow, label?, createdBy? }. id is minted lazily
  // on first spend so annotated routes that never spend cost no row.
  return store.run({ ...ctx, keyProvenance: null, requestTypeOverride: null }, fn);
}

export function currentActivation() {
  return store.getStore() || null;
}

export function setKeyProvenance(p) {
  const c = store.getStore();
  if (c) c.keyProvenance = p;
}

export function takeKeyProvenance() {
  const c = store.getStore();
  if (!c || !c.keyProvenance) return null;
  const p = c.keyProvenance;
  c.keyProvenance = null;
  return p;
}

export function setRequestType(t) {
  const c = store.getStore();
  if (c) c.requestTypeOverride = t;
}

// Ensure the activation ROW exists (mint lazily) using the caller's
// provided query (the recorder's own transaction). A call with no
// ambient context gets a STANDALONE activation for this call only:
// never enterWith, which would bleed one lifecycle across unrelated
// work sharing an async chain (the scheduler sweep case).
export async function ensureActivationId(fallbackWorkflow, deps = {}) {
  const q = deps.query || ((sql, params) => currentClient().query(sql, params));
  const c = store.getStore();
  if (c && c.id) return c.id;
  const id = randomUUID();
  const workflow = (c && c.workflow) || fallbackWorkflow;
  const label = c ? (c.label || null) : "(unattributed)";
  const createdBy = (c && c.createdBy) || null;
  await q(
    `INSERT INTO llm_activations (id, tenant_id, workflow, label, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, deps.tenantId || currentTenantId(), workflow, label, createdBy]
  );
  if (c) c.id = id;
  return id;
}
