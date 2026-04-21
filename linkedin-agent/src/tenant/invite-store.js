// ═══════════════════════════════════════════════════════════════
// src/tenant/invite-store.js — invite lifecycle management
// ═══════════════════════════════════════════════════════════════
// All functions run inside withTenant (RLS-scoped). The invites
// table is tenant-isolated — each workspace has its own invites.
//
// Invite lifecycle:
//   pending  → claimed  (user logs in with matching email)
//   pending  → revoked  (owner cancels the invite)
//   pending  → expired  (future: TTL expiration job)
// ═══════════════════════════════════════════════════════════════

import { currentClient } from "../db/with-tenant.js";

/**
 * Create a pending invite. Normalizes email to lowercase and
 * extracts the domain. Returns the created invite row.
 *
 * Throws on duplicate pending invite for the same email+tenant
 * (unique partial index catches it).
 */
export async function createInvite({ email, role, invitedBy }) {
  const c = currentClient();
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1] || "";

  const r = await c.query(
    `INSERT INTO invites (tenant_id, email, email_domain, role, invited_by, status)
     VALUES (current_tenant_id(), $1, $2, $3::member_role, $4, 'pending')
     RETURNING id, tenant_id, email, email_domain, role::text, invited_by,
               status::text, created_at, expires_at, claimed_at, claimed_by_sub`,
    [normalized, domain, role, invitedBy]
  );
  return r.rows[0];
}

/**
 * List pending invites for the current tenant.
 */
export async function listPendingInvites() {
  const c = currentClient();
  const r = await c.query(
    `SELECT id, email, email_domain, role::text, invited_by,
            status::text, created_at, expires_at
     FROM invites
     WHERE tenant_id = current_tenant_id()
       AND status = 'pending'::invite_status
     ORDER BY created_at DESC`
  );
  return r.rows;
}

/**
 * Revoke a pending invite by ID. Sets status to 'revoked'.
 * Returns true if the invite was found and revoked, false otherwise.
 */
export async function revokeInvite(inviteId) {
  const c = currentClient();
  const r = await c.query(
    `UPDATE invites SET status = 'revoked'::invite_status
     WHERE id = $1
       AND tenant_id = current_tenant_id()
       AND status = 'pending'::invite_status
     RETURNING id`,
    [inviteId]
  );
  return r.rowCount > 0;
}

/**
 * Find a pending invite by email (case-insensitive).
 * Used by the resolver during the claim flow.
 * Returns the invite row or null.
 */
export async function findPendingInviteByEmail(email) {
  if (!email || typeof email !== "string") return null;
  const c = currentClient();
  const r = await c.query(
    `SELECT id, tenant_id, email, email_domain, role::text, invited_by,
            status::text, created_at, expires_at
     FROM invites
     WHERE tenant_id = current_tenant_id()
       AND lower(email) = $1
       AND status = 'pending'::invite_status
     LIMIT 1`,
    [email.trim().toLowerCase()]
  );
  return r.rows[0] || null;
}

/**
 * Mark an invite as claimed. Sets status, claimed_at, and
 * claimed_by_sub. Called after the membership row is created.
 */
export async function markInviteClaimed(inviteId, claimedBySub) {
  const c = currentClient();
  await c.query(
    `UPDATE invites
     SET status = 'claimed'::invite_status,
         claimed_at = now(),
         claimed_by_sub = $2
     WHERE id = $1`,
    [inviteId, claimedBySub]
  );
}
