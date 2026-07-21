// ═══════════════════════════════════════════════════════════════
// src/tenant/permissions.js — route-level permission enforcement
// ═══════════════════════════════════════════════════════════════
// Express middleware factory. Each route declares which permission
// it requires; the middleware checks the authenticated user's role
// against the role_permissions table via hasPermission().
//
// Chain order:  requireAuth → resolveTenant → requirePermission → handler
//
// requirePermission reads req.tenant.role (set by resolveTenant)
// and calls hasPermission(role, permission). If denied, returns
// 403 with a generic "Permission denied" message — no details
// about which permission was required (Zero Trust: don't help
// the attacker narrow the attack surface).
//
// Error handling: if hasPermission throws (e.g. database failure
// on first cache load), returns 500 instead of crashing. The
// permission check failing is NOT the same as permission denied.
// ═══════════════════════════════════════════════════════════════

import { hasPermission } from "./platform-db.js";

/**
 * Returns Express middleware that enforces a specific permission.
 *
 * @param {string} permission — one of the permission strings from
 *   the role_permissions table (e.g. 'view_dashboard', 'change_mode')
 * @returns {Function} async Express middleware (req, res, next)
 *
 * Usage:
 *   router.post("/api/mode", requirePermission("change_mode"), handler);
 */
export function requirePermission(permission) {
  return async function permissionCheck(req, res, next) {
    // Defensive: if resolveTenant didn't run or failed silently,
    // req.tenant or req.tenant.role may be missing.
    const role = req.tenant?.role;
    if (!role) {
      return res.status(403).json({ error: "Permission denied" });
    }

    try {
      const allowed = await hasPermission(role, permission);
      if (!allowed) {
        return res.status(403).json({ error: "Permission denied" });
      }
      next();
    } catch (err) {
      // The refusal semantics below are deliberate and stay; the
      // error itself must not vanish: which database failure denied
      // this request matters to whoever debugs it.
      console.error("[permissions] permission check failed:", err.message);
      // hasPermission threw — database failure, not a policy decision.
      // Return 500 so the caller knows it's a server error, not a
      // deliberate denial. Do not expose the internal error message.
      return res.status(500).json({ error: "Permission check failed" });
    }
  };
}

/**
 * Express middleware that blocks dev bypass users. Used on admin
 * endpoints where synthetic user access is not acceptable —
 * even in development, admin actions should require a real login.
 *
 * Chain order: requireAuth → resolveTenant → requireNoDevBypass
 *              → requirePermission → handler
 *
 * Returns 403 with a generic message. Does not reveal that the
 * block is dev-bypass-specific (Zero Trust).
 */
export function requireNoDevBypass() {
  return function devBypassBlock(req, res, next) {
    if (req.devBypass) {
      return res.status(403).json({ error: "Permission denied" });
    }
    next();
  };
}
