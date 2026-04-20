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
// Returns { id, slug, name, status, role, created_at } or null.
// The role field comes from the memberships table and indicates
// what the user is allowed to do in this workspace.
export async function findTenantByAuthIdentity(provider, sub) {
  const result = await query(
    `SELECT t.id, t.slug, t.name, t.status, t.created_at, t.updated_at,
            m.role::text AS role
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

// ── Permission checking ──────────────────────────────────────
// Loads the role_permissions table once and caches it as a
// Map<role, Set<permission>>. Subsequent calls are O(1) lookups.
// The cache is process-lifetime — role_permissions is static
// configuration that changes only via DDL, not at runtime.

let _permissionCache = null;

async function loadPermissions() {
  if (_permissionCache) return _permissionCache;
  const result = await query(
    `SELECT role::text, permission FROM role_permissions`
  );
  const cache = new Map();
  for (const row of result.rows) {
    if (!cache.has(row.role)) {
      cache.set(row.role, new Set());
    }
    cache.get(row.role).add(row.permission);
  }
  _permissionCache = cache;
  return cache;
}

// Returns true if the given role has the specified permission.
// Returns false for unknown roles, unknown permissions, or if
// the role_permissions table is empty.
//
// Usage: if (await hasPermission(req.tenant.role, 'change_mode')) { ... }
export async function hasPermission(role, permission) {
  const cache = await loadPermissions();
  const perms = cache.get(role);
  if (!perms) return false;
  return perms.has(permission);
}

// Exposed for testing — clears the cached permission matrix so
// the next hasPermission call re-reads from the database.
export function _resetPermissionCacheForTesting() {
  _permissionCache = null;
}
