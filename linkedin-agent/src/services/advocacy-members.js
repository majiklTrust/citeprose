// =================================================================
// src/services/advocacy-members.js, participation lifecycle (D2)
// =================================================================
// Advocacy members ARE existing tenant members: participation is a
// consent-gated attribute, one advocacy_members row per enabled
// member. Owner enables and disables (manage_advocacy); the member
// alone consents, connects, sets their mode, and disconnects.
// Disable and disconnect both wipe the member's stored secrets
// (FR-P2-02); pending-variant voiding arrives with the Step 2
// variants table and hooks into disconnectSelf below.
//
// Every function runs INSIDE withTenant. DB access is lazy so the
// module imports with zero environment; validators are pure.
// =================================================================

export const ADVOCACY_MODES = Object.freeze(["manual", "auto"]);
export const CONSENT_TEXT_VERSION = "v1";

export function isValidAdvocacyMode(value) {
  return typeof value === "string" && ADVOCACY_MODES.includes(value);
}

async function client() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("advocacy members requires tenant context (withTenant)");
  return c;
}

// Owner enables a tenant member for advocacy. The sub must belong
// to a membership of THIS tenant (fail closed: an owner cannot
// enroll an arbitrary identity string).
export async function enableMember(authSub, enabledBy) {
  if (typeof authSub !== "string" || authSub.trim().length === 0) {
    return { status: "rejected", reason: "authSub is required" };
  }
  const sub = authSub.trim();
  const c = await client();
  const membership = await c.query(
    "SELECT 1 FROM memberships WHERE tenant_id = current_tenant_id() AND auth_sub = $1",
    [sub]
  );
  if (membership.rows.length === 0) {
    return { status: "rejected", reason: "no membership with that sub in this workspace" };
  }
  await c.query(
    `INSERT INTO advocacy_members (tenant_id, auth_sub, enabled_by)
     VALUES (current_tenant_id(), $1, $2)
     ON CONFLICT (tenant_id, auth_sub) DO NOTHING`,
    [sub, enabledBy || null]
  );
  return { status: "enabled", authSub: sub };
}

// Owner disables: removes the participation row AND every stored
// member secret. Fail closed on secrets even if the row was gone.
export async function disableMember(authSub) {
  const sub = String(authSub || "").trim();
  if (!sub) return { status: "rejected", reason: "authSub is required" };
  const c = await client();
  const { deleteAllMemberCredentials } = await import("../tenant/member-credential-store.js");
  const wiped = await deleteAllMemberCredentials(sub);
  const r = await c.query(
    "DELETE FROM advocacy_members WHERE auth_sub = $1",
    [sub]
  );
  return { status: "disabled", removed: r.rowCount || 0, credentialsWiped: wiped };
}

export async function listMembers() {
  const c = await client();
  const { rows } = await c.query(
    `SELECT auth_sub, enabled_by, enabled_at, consent_granted_at, consent_text_version,
            mode, auto_opted_in_at, connected, disconnected_at,
            connections_size, connections_size_at
       FROM advocacy_members
      ORDER BY enabled_at ASC`
  );
  return rows;
}

export async function getSelf(authSub) {
  const c = await client();
  const { rows } = await c.query(
    `SELECT auth_sub, enabled_at, consent_granted_at, consent_text_version,
            mode, auto_opted_in_at, connected, disconnected_at,
            connections_size, connections_size_at
       FROM advocacy_members
      WHERE auth_sub = $1`,
    [authSub]
  );
  return rows.length === 0 ? null : rows[0];
}

// Mode is the member's alone (FR-P2-04): the route derives the sub
// from the session and calls this; auto additionally requires a
// live connection and stamps the opt-in moment.
export async function setSelfMode(authSub, mode) {
  if (!isValidAdvocacyMode(mode)) {
    return { status: "rejected", reason: "mode must be 'manual' or 'auto'" };
  }
  const c = await client();
  const self = await getSelf(authSub);
  if (!self) return { status: "rejected", reason: "advocacy is not enabled for this member" };
  if (mode === "auto" && !self.connected) {
    return { status: "rejected", reason: "auto mode requires a connected LinkedIn profile" };
  }
  await c.query(
    `UPDATE advocacy_members
        SET mode = $2,
            auto_opted_in_at = CASE WHEN $2 = 'auto' THEN now() ELSE auto_opted_in_at END,
            updated_at = now()
      WHERE auth_sub = $1`,
    [authSub, mode]
  );
  return { status: "set", mode };
}

// Called by the member OAuth callback after tokens are stored.
export async function markConnected(authSub, consentVersion) {
  const c = await client();
  const r = await c.query(
    `UPDATE advocacy_members
        SET connected = true,
            consent_granted_at = now(),
            consent_text_version = $2,
            disconnected_at = NULL,
            updated_at = now()
      WHERE auth_sub = $1`,
    [authSub, consentVersion || CONSENT_TEXT_VERSION]
  );
  return { status: r.rowCount > 0 ? "connected" : "not_enabled" };
}

export async function snapshotConnectionsSize(authSub, size) {
  const n = typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.floor(size) : null;
  if (n === null) return { status: "skipped" };
  const c = await client();
  await c.query(
    `UPDATE advocacy_members
        SET connections_size = $2, connections_size_at = now(), updated_at = now()
      WHERE auth_sub = $1`,
    [authSub, n]
  );
  return { status: "stored", size: n };
}

// Member-initiated disconnect (FR-P2-02): stops advocacy for them
// immediately, wipes their secrets, keeps the participation row so
// the owner still sees them as enabled-but-disconnected.
// Step 2 hook: void the member's pending variants here.
export async function disconnectSelf(authSub) {
  const c = await client();
  const { deleteAllMemberCredentials } = await import("../tenant/member-credential-store.js");
  const wiped = await deleteAllMemberCredentials(authSub);
  const r = await c.query(
    `UPDATE advocacy_members
        SET connected = false, disconnected_at = now(), mode = 'manual', updated_at = now()
      WHERE auth_sub = $1`,
    [authSub]
  );
  return { status: r.rowCount > 0 ? "disconnected" : "not_enabled", credentialsWiped: wiped };
}
