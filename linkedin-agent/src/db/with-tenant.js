// ═══════════════════════════════════════════════════════════════
// src/db/with-tenant.js — per-request tenant context via
// AsyncLocalStorage + PostgreSQL SET LOCAL
// ═══════════════════════════════════════════════════════════════
// Usage:
//   import { withTenant, currentTenantId } from './with-tenant.js';
//
//   // In a route handler or scheduler loop:
//   await withTenant(tenantUuid, async (client) => {
//     // client has SET LOCAL app.current_tenant_id = tenantUuid
//     // RLS policies enforce visibility automatically
//     const r = await client.query('SELECT * FROM posts');
//     // currentTenantId() returns tenantUuid inside this block
//   });
//   // After the block: transaction committed, context cleared.
//
// The callback receives a dedicated pg.Client (checked out from
// the pool) that is wrapped in a transaction with SET LOCAL
// applied. The AsyncLocalStorage store holds both the tenant id
// and the client so that downstream modules (like credential-
// store.js) can access them without explicit parameter passing.
// ═══════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "./pool.js";

const als = new AsyncLocalStorage();

// ── Public API ───────────────────────────────────────────────

// Returns the current tenant UUID, or null if called outside
// a withTenant block. Safe to call from anywhere — never throws.
export function currentTenantId() {
  const store = als.getStore();
  return store ? store.tenantId : null;
}

// Returns the dedicated pg.Client for the current tenant
// transaction, or null if called outside a withTenant block.
// Used by internal modules like credential-store.js. Not part
// of the public-facing API for route handlers — they get the
// client as a callback parameter from withTenant.
export function currentClient() {
  const store = als.getStore();
  return store ? store.client : null;
}

// Wraps `fn` in a PostgreSQL transaction with the tenant
// context set via SET LOCAL. The callback receives the
// dedicated client as its first argument.
//
// On success: COMMIT, client released to pool.
// On error:   ROLLBACK, client released, error re-thrown.
//
// SET LOCAL is transaction-scoped — the setting is
// automatically cleared when the transaction ends, so a
// pooled connection can never leak tenant context to a
// subsequent request.
export async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL does not accept parameterized placeholders ($1, $2)
    // in PostgreSQL — it's a utility command parsed outside the
    // regular bind protocol. Use set_config(name, value, is_local)
    // instead. The `true` third argument makes it transaction-
    // scoped, equivalent to SET LOCAL.
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId]
    );
    const result = await als.run({ tenantId, client }, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
