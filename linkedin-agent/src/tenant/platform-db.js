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
import { randomBytes } from "node:crypto";

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
  // Atomic: CTE INSERT + UPDATE runs as a single statement.
  // If the membership INSERT fails (e.g., constraint violation),
  // the invite UPDATE does not execute. No orphaned state.
  await query(
    `WITH new_membership AS (
       INSERT INTO memberships (tenant_id, auth_provider, auth_sub, role)
       SELECT i.tenant_id, $2::auth_provider, $3, i.role
       FROM invites i
       WHERE i.id = $1 AND i.status = 'pending'::invite_status
       RETURNING tenant_id
     )
     UPDATE invites
     SET status = 'claimed'::invite_status,
         claimed_at = now(),
         claimed_by_sub = $3
     WHERE id = $1 AND EXISTS (SELECT 1 FROM new_membership)`,
    [inviteId, provider, sub]
  );

  // Return the tenant via the newly created membership
  return findTenantByAuthIdentity(provider, sub);
}

// ── Platform Admin ───────────────────────────────────────────
// Identified by PLATFORM_ADMIN_SUBS in .env. No database role —
// this is a backend-only designation. The admin retains their
// normal tenant role and permissions. This flag is additive.

/**
 * Check if a user sub is a platform admin.
 * Reads PLATFORM_ADMIN_SUBS from environment (comma-separated).
 */
export function isPlatformAdmin(sub) {
  if (!sub || typeof sub !== "string") return false;
  const adminSubs = process.env.PLATFORM_ADMIN_SUBS;
  if (!adminSubs) return false;
  const list = adminSubs.split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(sub);
}

// ── Tenant Registration ──────────────────────────────────────
// Self-service registration flow. A platform admin creates a
// registration invite (token + email). The invitee visits the
// registration page, fills the form, and the system creates a
// tenant + pending owner invite. The invitee then logs in via
// Auth0, the resolver claims the invite, and they land on their
// new dashboard.

const DEFAULT_TTL_MINUTES = 15;

function getRegistrationTTL() {
  const envVal = parseInt(process.env.REGISTRATION_INVITE_TTL_MINUTES, 10);
  return envVal > 0 ? envVal : DEFAULT_TTL_MINUTES;
}

/**
 * Create a registration invite. Platform admin only.
 * Returns { id, token, email, expires_at }.
 */
export async function createRegistrationInvite(email, invitedBySub) {
  const token = randomBytes(32).toString("base64url");
  const ttl = getRegistrationTTL();
  const result = await query(
    `INSERT INTO tenant_registrations (token, email, invited_by_sub, expires_at)
     VALUES ($1, lower($2), $3, now() + ($4 || ' minutes')::interval)
     RETURNING id, token, email, expires_at`,
    [token, email.trim(), invitedBySub, String(ttl)]
  );
  return result.rows[0];
}

/**
 * Validate a registration token. Returns the registration row
 * if valid (pending or active, not expired). Returns null otherwise.
 */
export async function validateRegistrationToken(token) {
  if (!token || typeof token !== "string") return null;
  const result = await query(
    `SELECT id, token, email, status, invited_by_sub, tenant_id, expires_at, created_at
     FROM tenant_registrations
     WHERE token = $1
       AND status IN ('pending', 'active')
       AND expires_at > now()`,
    [token]
  );
  return result.rows[0] || null;
}

/**
 * Mark a token as active (page loaded). Only transitions from pending.
 */
export async function activateRegistrationToken(token) {
  const result = await query(
    `UPDATE tenant_registrations
     SET status = 'active'
     WHERE token = $1 AND status = 'pending'
     RETURNING id, email, expires_at`,
    [token]
  );
  return result.rows[0] || null;
}

/**
 * Complete registration. Atomic: creates tenant, marks token as
 * claimed, sets tenant_id on the registration row.
 *
 * Returns the new tenant UUID or null on failure.
 * Caller is responsible for creating agent_state, credentials,
 * and the pending owner invite inside withTenant.
 */
export async function completeRegistration(token, slug, name) {
  // SELECT FOR UPDATE prevents race conditions on the same token.
  // The entire operation is a single statement via CTE — atomic.
  const result = await query(
    `WITH valid_reg AS (
       SELECT id FROM tenant_registrations
       WHERE token = $1 AND status = 'active' AND expires_at > now()
       FOR UPDATE
     ),
     new_tenant AS (
       INSERT INTO tenants (slug, name, status)
       SELECT $2, $3, 'active'::tenant_status
       FROM valid_reg
       WHERE EXISTS (SELECT 1 FROM valid_reg)
       RETURNING id
     )
     UPDATE tenant_registrations
     SET status = 'claimed',
         claimed_at = now(),
         tenant_id = (SELECT id FROM new_tenant)
     WHERE token = $1
       AND EXISTS (SELECT 1 FROM new_tenant)
     RETURNING tenant_id`,
    [token, slug, name]
  );
  return result.rows[0]?.tenant_id || null;
}

/**
 * Expire stale registrations. Called by a cleanup job.
 * Transitions pending/active tokens past their expires_at to expired.
 */
export async function expireStaleRegistrations() {
  const result = await query(
    `UPDATE tenant_registrations
     SET status = 'expired'
     WHERE status IN ('pending', 'active')
       AND expires_at <= now()`
  );
  return result.rowCount;
}
