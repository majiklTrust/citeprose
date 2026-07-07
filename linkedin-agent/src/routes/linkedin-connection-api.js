// =================================================================
// src/routes/linkedin-connection-api.js, connection management
// =================================================================
// Router-level middleware: requireAuth -> resolveTenant. Every
// route is gated by manage_linkedin (owner only per the delivery
// decision record); connection identity, authorship, and token
// material are tenant-shaping controls.
//
// Endpoints:
//   GET  /            connection status (booleans + bookmarks; no
//                     token values ever leave the server)
//   POST /publish-target   { target } toggle personal|organization;
//                     organization requires a stored org URN
//   POST /tokens      { accessToken, refreshToken, expiresIn?,
//                     refreshTokenExpiresIn? } atomic manual set
//   POST /org/discover     run ACL discovery with the stored token;
//                     returns candidates; auto-stores a single hit
//   POST /org         { orgUrn } store a discovered org URN; the
//                     value must appear in a FRESH discovery result
//                     (fail closed: the client cannot inject an
//                     arbitrary organization)
// =================================================================

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { setManualTokens } from "../services/linkedin-token.js";
import { fetchAdministeredOrgs } from "../services/linkedin-orgs.js";
import { isValidPublishTarget, getPublishTarget } from "../services/publish-target.js";
import { isOrganizationUrn } from "../services/linkedin-analytics.js";
import { isLinkedInApiError } from "../services/linkedin-errors.js";
import {
  getLinkedInAccessToken, getLinkedInPersonUrn, getLinkedInOrgUrn,
  hasLinkedInRefreshToken, hasLinkedInOrgUrn, storeCredential
} from "../tenant/credential-store.js";

const router = Router();
const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.use(requireAuth);
router.use(resolveTenant);

async function safeGet(fn) {
  try { return await fn(); } catch { return null; }
}

// ── GET / ─────────────────────────────────────────────────────
router.get("/", requirePermission("manage_linkedin"), async (req, res) => {
  try {
    const out = await withTenant(req.tenant.id, async () => {
      const { getAgentState } = await import("../services/database.js");
      const accessToken = await safeGet(getLinkedInAccessToken);
      return {
        linkedinConnected: !!accessToken,
        hasRefreshToken: await hasLinkedInRefreshToken(),
        orgConfigured: await hasLinkedInOrgUrn(),
        personUrn: await safeGet(getLinkedInPersonUrn),
        orgUrn: await safeGet(getLinkedInOrgUrn),
        publishTarget: await getPublishTarget(),
        accessTokenExpiresAt: await safeGet(() => getAgentState("linkedin_token_expires_at")),
        refreshTokenExpiresAt: await safeGet(() => getAgentState("linkedin_refresh_expires_at"))
      };
    });
    res.json(out);
  } catch (err) {
    platformLog("error", "linkedin_connection_status_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load connection status" });
  }
});

// ── POST /publish-target ──────────────────────────────────────
router.post("/publish-target", requirePermission("manage_linkedin"), async (req, res) => {
  try {
    const { target } = req.body || {};
    if (!isValidPublishTarget(target)) {
      return res.status(400).json({ error: "target must be 'personal' or 'organization'" });
    }
    const result = await withTenant(req.tenant.id, async () => {
      if (target === "organization" && !(await hasLinkedInOrgUrn())) {
        return { blocked: "LINKEDIN_ORG_NOT_CONFIGURED" };
      }
      const { setAgentState, logActivity } = await import("../services/database.js");
      await setAgentState("publish_target", target);
      await logActivity("info", "publish_target_changed", { target }, req.user?.sub || null);
      return { target };
    });
    if (result.blocked) {
      return res.status(409).json({
        error: "No organization page is configured; connect one before switching",
        code: result.blocked
      });
    }
    res.json(result);
  } catch (err) {
    platformLog("error", "publish_target_change_failed", { error: err.message });
    res.status(500).json({ error: "Failed to change publish target" });
  }
});

// ── POST /tokens ──────────────────────────────────────────────
router.post("/tokens", requirePermission("manage_linkedin"), async (req, res) => {
  try {
    const { accessToken, refreshToken, expiresIn, refreshTokenExpiresIn } = req.body || {};
    const result = await withTenant(req.tenant.id, () =>
      setManualTokens(
        { accessToken, refreshToken, expiresIn, refreshTokenExpiresIn },
        { tenantId: req.tenant.id }
      )
    );
    if (result.status === "rejected") {
      return res.status(400).json({ error: result.reason });
    }
    res.json({
      success: true,
      accessExpiryBookmarked: result.accessExpiryBookmarked,
      refreshExpiryBookmarked: result.refreshExpiryBookmarked,
      note: result.accessExpiryBookmarked
        ? "Expiries bookmarked; the refresher will renew inside its buffer window"
        : "No expiries supplied; the next refresher sweep will rotate the pair and establish them"
    });
  } catch (err) {
    platformLog("error", "linkedin_manual_tokens_failed", { error: err.message });
    res.status(500).json({ error: "Failed to store tokens" });
  }
});

// Discovery core shared by both org endpoints. Always uses the
// STORED access token and the STORED person URN; nothing about the
// discovery is caller-influenced except which discovered org to
// keep.
async function discoverOrgs() {
  const token = await getLinkedInAccessToken();
  const personUrn = await getLinkedInPersonUrn();
  return fetchAdministeredOrgs(token, personUrn);
}

function orgFailureResponse(res, err) {
  if (isLinkedInApiError(err)) {
    const status = err.code === "LINKEDIN_RATE_LIMITED" ? 429 : 502;
    return res.status(status).json({ error: "Organization discovery failed", code: err.code });
  }
  return res.status(409).json({
    error: "LinkedIn is not connected for this workspace",
    code: "LINKEDIN_NOT_CONNECTED"
  });
}

// ── POST /org/discover ────────────────────────────────────────
router.post("/org/discover", requirePermission("manage_linkedin"), async (req, res) => {
  try {
    const out = await withTenant(req.tenant.id, async () => {
      const orgs = await discoverOrgs();
      if (orgs.length === 1) {
        await storeCredential("linkedin_org_urn", orgs[0].orgUrn);
        const { logActivity } = await import("../services/database.js");
        await logActivity("info", "linkedin_org_connected", {
          orgUrn: orgs[0].orgUrn, via: "discovery_single"
        }, req.user?.sub || null);
        return { stored: orgs[0].orgUrn, candidates: orgs };
      }
      return { stored: null, candidates: orgs };
    });
    res.json(out);
  } catch (err) {
    platformLog("warn", "linkedin_org_discovery_failed", {
      code: isLinkedInApiError(err) ? err.code : "not_connected"
    });
    return orgFailureResponse(res, err);
  }
});

// ── POST /org ─────────────────────────────────────────────────
router.post("/org", requirePermission("manage_linkedin"), async (req, res) => {
  try {
    const { orgUrn } = req.body || {};
    if (!isOrganizationUrn(orgUrn)) {
      return res.status(400).json({ error: "orgUrn must be a urn:li:organization:{id} value" });
    }
    const out = await withTenant(req.tenant.id, async () => {
      // Fail closed: only an org the connected person verifiably
      // administers RIGHT NOW can be stored, so a hostile client
      // cannot attach an arbitrary organization to the tenant.
      const orgs = await discoverOrgs();
      if (!orgs.some((o) => o.orgUrn === orgUrn)) {
        return { rejected: true };
      }
      await storeCredential("linkedin_org_urn", orgUrn);
      const { logActivity } = await import("../services/database.js");
      await logActivity("info", "linkedin_org_connected", {
        orgUrn, via: "operator_selection"
      }, req.user?.sub || null);
      return { stored: orgUrn };
    });
    if (out.rejected) {
      return res.status(403).json({
        error: "That organization is not administered by the connected LinkedIn member"
      });
    }
    res.json(out);
  } catch (err) {
    platformLog("warn", "linkedin_org_connect_failed", {
      code: isLinkedInApiError(err) ? err.code : "not_connected"
    });
    return orgFailureResponse(res, err);
  }
});

export default router;
