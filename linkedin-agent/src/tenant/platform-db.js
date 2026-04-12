// ═══════════════════════════════════════════════════════════════
// src/tenant/platform-db.js — read access to platform tables
// ═══════════════════════════════════════════════════════════════
// tenants and memberships are NOT subject to RLS. The app reads
// them BEFORE any tenant context is established — to resolve
// "which tenant does this logged-in user belong to?"
//
// Uses the shared pool directly. No withTenant wrapper needed.
// The ***REMOVED*** role has SELECT-only access to these
// tables via the grants in 04-roles.sql.
// ═══════════════════════════════════════════════════════════════

import { query } from "../db/pool.js";

// Looks up a tenant by the authenticated user's identity.
// Returns { id, slug, name, status, created_at } or null.
export async function findTenantByAuthIdentity(provider, sub) {
  const result = await query(
    `SELECT t.id, t.slug, t.name, t.status, t.created_at, t.updated_at
     FROM memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.auth_provider = $1::auth_provider AND m.auth_sub = $2
       AND t.status = 'active'::tenant_status
     LIMIT 1`,
    [provider, sub]
  );
  return result.rows[0] || null;
}

// Returns all active tenants. Used by the scheduler to iterate
// over tenants for the agent cycle. Returns an array of
// { id, slug, name, status, created_at } objects.
export async function listActiveTenants() {
  const result = await query(
    `SELECT id, slug, name, status, created_at, updated_at
     FROM tenants
     WHERE status = 'active'::tenant_status
     ORDER BY created_at`
  );
  return result.rows;
}
