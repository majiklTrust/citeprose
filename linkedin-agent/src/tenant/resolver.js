// ═══════════════════════════════════════════════════════════════
// src/tenant/resolver.js — Express middleware: auth → tenant
// ═══════════════════════════════════════════════════════════════
// Runs AFTER requireAuth. Reads req.user.sub and req.user.provider,
// looks up the membership in the platform tables, and attaches
// req.tenant. Returns 403 if no user or no membership found.
//
// Usage in Express app setup:
//   import { createTenantResolver } from './tenant/resolver.js';
//   app.use('/api', requireAuth, createTenantResolver());
//
// req.tenant shape after resolution:
//   { id, slug, name, status, role, created_at, updated_at }
// ═══════════════════════════════════════════════════════════════

import { findTenantByAuthIdentity, findPendingInviteByEmail, claimInvite, isSelfRegisteredOwner } from "./platform-db.js";
import { platformLog } from "../services/platform-log.js";

export function createTenantResolver() {
  return async function tenantResolver(req, res, next) {
    // No authenticated user — cannot resolve tenant
    if (!req.user || !req.user.sub) {
      res.status(403).json({ error: "Authentication required for tenant resolution" });
      return;
    }

    // Determine the auth provider. The middleware upstream may
    // set req.user.provider explicitly, or we can infer it from
    // the sub prefix (auth0|..., google-oauth2|..., etc.).
    const provider = req.user.provider || inferProvider(req.user.sub);
    if (!provider) {
      res.status(403).json({ error: "Unable to determine auth provider" });
      return;
    }

    // ── Path 1: Existing membership ──────────────────────────
    const tenant = await findTenantByAuthIdentity(provider, req.user.sub);
    if (tenant) {
      req.tenant = tenant;
      return next();
    }

    // ── Path 2: Invite claim ─────────────────────────────────
    // No membership found. Before returning 403, check if the
    // user's email matches a pending invite. If so, create a
    // membership from the invite and proceed.
    //
    // req.user.email comes from Auth0's userinfo endpoint via
    // the session cookie. It may be null for some social logins.
    const email = req.user.email;

    platformLog("info", "tenant_resolve_attempt", {
      sub: req.user.sub,
      email: email || "(null)",
      provider,
      path1_found: false
    });

    if (email) {
      try {
        const invite = await findPendingInviteByEmail(email);

        platformLog("info", "tenant_resolve_invite_lookup", {
          email,
          inviteFound: !!invite,
          inviteId: invite?.id || null,
          inviteTenant: invite?.tenant_id || null
        });

        if (invite) {
          // ── Email verification gate (Zero Trust) ─────────────
          // A pending invite must never be claimable by an identity
          // whose email address is unverified: an attacker who
          // registers the invitee's address at the IDP without
          // proving ownership could otherwise hijack the invite.
          // Strict !== true fails closed on false, missing, string,
          // and numeric impostors. The gate sits at the claim
          // decision itself, so existing members (Path 1) and users
          // with no invite (generic denial below) are unaffected.
          // 4.25111.78 (owner's ruling: Auth0 email verification is
          // optional): the one invitation an unverified login may claim
          // is the owner invitation of the workspace that login created
          // itself through self-registration. The session proves that
          // identity; the gate stays for every other invitation.
          if (req.user.emailVerified !== true) {
            const own = await isSelfRegisteredOwner(invite.tenant_id, req.user.sub);
            if (!own) {
              platformLog("warn", "tenant_resolve_unverified_email", { sub: req.user.sub });
              res.status(403).json({ error: "Email address not verified. Please verify your email before joining a workspace." });
              return;
            }
            platformLog("info", "tenant_resolve_self_registered_owner", { sub: req.user.sub, tenantId: invite.tenant_id });
          }
          const claimed = await claimInvite(invite.id, provider, req.user.sub);

          platformLog("info", "tenant_resolve_claim_result", {
            inviteId: invite.id,
            claimed: !!claimed,
            tenantId: claimed?.id || null
          });

          if (claimed) {
            req.tenant = claimed;
            req.inviteClaimed = true;
            return next();
          }
        }
      } catch (claimErr) {
        // Claim failed — fall through to 403.
        // Do not expose the error to the client, but log it
        // so silent failures are diagnosable.
        platformLog("warn", "invite_claim_failed", {
          email,
          error: claimErr.message
        });
      }
    } else {
      platformLog("warn", "tenant_resolve_no_email", {
        sub: req.user.sub,
        provider,
        reason: "req.user.email is null — invite claim path skipped"
      });
    }

    res.status(403).json({ error: "No tenant membership for this identity" });
  };
}

// Infer auth provider from the sub string prefix.
// Auth0 subs look like "auth0|abc123" or "google-oauth2|abc123".
// WorkOS subs look like "user_01H...".
// Returns null if unrecognizable — caller handles the error.
function inferProvider(sub) {
  if (!sub || typeof sub !== "string") return null;
  if (sub.startsWith("auth0|") || sub.startsWith("google-oauth2|")) {
    return "auth0";
  }
  if (sub.startsWith("user_")) {
    return "workos";
  }
  return null;
}
