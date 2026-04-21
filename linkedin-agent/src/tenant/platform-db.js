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

// ── Invite claim flow (platform-level) ───────────────────────
// These functions use pool.query (no tenant context) because
// the invite claim runs inside the resolver BEFORE tenant
// resolution. The invites table has no RLS — like memberships,
// it is a platform table queried during auth resolution.

/**
 * Find a pending invite by email across all tenants.
 * Used by the resolver when sub lookup fails — checks if the
 * user's Auth0 email matches a pending invite.
 * Returns { id, tenant_id, email, role, ... } or null.
 */
export async function findPendingInviteByEmail(email) {
  if (!email || typeof email !== "string") return null;
  const result = await query(
    `SELECT i.id, i.tenant_id, i.email, i.email_domain,
            i.role::text AS role, i.invited_by, i.status::text AS status
     FROM invites i
     JOIN tenants t ON t.id = i.tenant_id
     WHERE lower(i.email) = $1
       AND i.status = 'pending'::invite_status
       AND t.status = 'active'::tenant_status
     LIMIT 1`,
    [email.trim().toLowerCase()]
  );
  return result.rows[0] || null;
}

/**
 * Claim an invite: create a membership row, mark the invite as
 * claimed, and return the resolved tenant.
 *
 * Runs as two pool-level queries (no withTenant needed).
 * The membership INSERT uses the invite's tenant_id and role.
 */
export async function claimInvite(inviteId, provider, sub) {
  // Create membership from the invite
  await query(
    `INSERT INTO memberships (tenant_id, auth_provider, auth_sub, role)
     SELECT i.tenant_id, $2::auth_provider, $3, i.role
     FROM invites i
     WHERE i.id = $1 AND i.status = 'pending'::invite_status`,
    [inviteId, provider, sub]
  );

  // Mark invite as claimed
  await query(
    `UPDATE invites
     SET status = 'claimed'::invite_status,
         claimed_at = now(),
         claimed_by_sub = $2
     WHERE id = $1`,
    [inviteId, sub]
  );

  // Return the tenant via the newly created membership
  return findTenantByAuthIdentity(provider, sub);
}
