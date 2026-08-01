// ═══════════════════════════════════════════════════════════════
// src/routes/registration-api.js — Tenant registration API
// ═══════════════════════════════════════════════════════════════
// Two groups of endpoints:
//
//   Authenticated (platform admin only):
//     POST /invite — create a registration invite
//
//   Unauthenticated (token-based):
//     POST /init          — validate token, mark active
//     POST /validate-key  — validate Anthropic key, return models
//     POST /complete      — create tenant + credentials + invite
//
// The unauthenticated endpoints use the registration token as
// their sole authorization. No session cookie, no Bearer token.
// Rate limiting on validate-key prevents oracle attacks.
// ═══════════════════════════════════════════════════════════════

import { suspendedWriteGuard } from "../services/entitlements.js";
import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { platformLog } from "../services/platform-log.js";
import {
  isPlatformAdmin,
  findTenantByAuthIdentity,
  createRegistrationInvite,
  validateRegistrationToken,
  activateRegistrationToken,
  completeRegistration,
  getRegistrationAdminKey,
  clearRegistrationKey
} from "../tenant/platform-db.js";
import { validateProviderKey } from "../llm/client.js";
import { isTextProviderAvailable, TEXT_GENERATION_NOTICE } from "../llm/registry.js";
import { withTenant } from "../db/with-tenant.js";
import { query } from "../db/pool.js";
import { storeCredential } from "../tenant/credential-store.js";
import { seedTenantDefaults } from "../tenant/seed-defaults.js";

const router = Router();

// Track validation attempts per token to prevent oracle attacks.
// In-memory — resets on server restart. Acceptable for a
// 15-minute token window.
const validationAttempts = new Map();
const MAX_VALIDATION_ATTEMPTS = 3;

// ── Helper: generate slug from org name ──────────────────────

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Helper: infer auth provider from the sub prefix ──────────
// Mirrors the private inferProvider in tenant/resolver.js so the
// owner-session authorization below resolves memberships the same
// way the tenant resolver does.
function inferAuthProvider(sub) {
  if (!sub || typeof sub !== "string") return null;
  if (sub.startsWith("auth0|") || sub.startsWith("google-oauth2|")) return "auth0";
  if (sub.startsWith("user_")) return "workos";
  return null;
}

// ── Helper: safe error — never leak internals ────────────────

function safeError(res, status, message) {
  return res.status(status).json({ error: message });
}

// ══════════════════════════════════════════════════════════════
// Authenticated: Create registration invite (platform admin)
// ══════════════════════════════════════════════════════════════

const { requireAuth, optionalAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.post("/invite", requireAuth, resolveTenant, suspendedWriteGuard(), async (req, res) => {
  try {
    // Platform admin check
    if (!isPlatformAdmin(req.user.sub)) {
      return safeError(res, 403, "Permission denied");
    }

    const { email, api_key, model_id } = req.body || {};
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return safeError(res, 400, "Valid email address required");
    }

    // If admin is providing an API key, validate it first.
    // Routed through the provider abstraction (registry, auth
    // scheme, egress allowlist): registration provisioning stays
    // on the platform default vendor, anthropic. Zero token cost.
    let validatedKey = null;
    let validatedModel = null;
    if (api_key && typeof api_key === "string" && api_key.trim().length > 0) {
      if (!model_id || typeof model_id !== "string") {
        return safeError(res, 400, "Model selection required when providing an API key");
      }
      let keyCheck;
      try {
        keyCheck = await validateProviderKey("anthropic", api_key.trim());
      } catch (err) {
        platformLog("warn", "provider_models_error", { provider: "anthropic", code: err?.code || null });
        return safeError(res, 502, "Unable to verify API key with the selected provider");
      }
      if (!keyCheck.valid) {
        return safeError(res, 401, "Invalid API key");
      }
      validatedKey = api_key.trim();
      validatedModel = model_id.trim();
    }

    const invite = await createRegistrationInvite(
      email.trim(), req.user.sub, validatedKey, validatedModel
    );

    // Build the registration URL and email template
    const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
    const brandName = process.env.BRAND_NAME || "Content Agent";
    const appName = process.env.APP_NAME || "Content Agent";
    const registerUrl = `${origin}/app/register#token=${invite.token}`;
// Your administrator has already provisioned your AI model connection and API key, so you can focus on what matters: getting your workspace configured and publishing great content.
// During registration, you will be prompted to create a secure login using your email address and a password of your choosing. Please use the email address at which you received this invitation.
    const emailSubject = `Your ${appName} Workspace`;

    // Adjust email body based on whether key was provided
    const whatYouNeed = validatedKey
      ? `  • a name for your workspace\n  • your Anthropic AI credentials have been configured by your administrator — no additional setup needed.`
      : `  • A name for your workspace\n  • An LLM vendor API key:\n    - https://console.anthropic.com/settings/keys\n    - https://platform.openai.com/api-keys\n    - https://console.x.ai/\n`;

    const expires = new Date(invite.expires_at)
    const emailBody = [
      `Welcome to ${appName} - your workspace is ready to for you.`,
      ``,
      `The ${appName} platform uses AI-powered research to help you create credible, professional content for social media and other brand marketing channels.`,
      `To get started, click the link below.`,
      ``,
      `What you'll need:`,
      whatYouNeed,
      ``,
      `What to expect when you click the link:`,
      `  • You will be guided through a short setup process to name and configure your workspace.`,
      ``,
      `This link can only be used once and expires at ${
  expires.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short"
  })
} on ${
  expires.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "numeric"
  })
} (${
  expires.toLocaleString("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  })
} UTC): ${registerUrl}`,
      ``,
      ``,
      `If you have any questions or did not expect this invitation, please contact your account administrator.`,
      ``,
      `Welcome aboard,`,
      `The ${brandName} Team`
    ].join("\n");

    platformLog("info", "registration_invite_created", {
      email: invite.email,
      invitedBy: req.user.sub,
      keyProvided: !!validatedKey,
      expiresAt: invite.expires_at
    });

    res.status(201).json({
      id: invite.id,
      email: invite.email,
      registerUrl,
      emailSubject,
      emailBody,
      expiresAt: invite.expires_at
    });
  } catch (err) {
    platformLog("error", "registration_invite_failed", { error: err.message });
    safeError(res, 500, "Failed to create registration invite");
  }
});

// ══════════════════════════════════════════════════════════════
// Unauthenticated: Initialize registration (validate + activate)
// ══════════════════════════════════════════════════════════════

router.post("/init", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== "string") {
      return safeError(res, 400, "Registration token required");
    }

    const reg = await validateRegistrationToken(token);
    if (!reg) {
      return safeError(res, 404, "Invalid or expired registration link");
    }

    // Activate if still pending (first page load)
    if (reg.status === "pending") {
      await activateRegistrationToken(token);
    }

    // Return non-sensitive registration info
    res.json({
      email: reg.email,
      expiresAt: reg.expires_at,
      keyProvided: reg.key_provided || false,
      modelId: reg.model_id || null
    });
  } catch (err) {
    platformLog("error", "registration_init_failed", { error: err.message });
    safeError(res, 500, "Registration initialization failed");
  }
});

// ══════════════════════════════════════════════════════════════
// Validate a vendor API key + list models (provider-aware)
// ══════════════════════════════════════════════════════════════
// One validation path for every caller: registration (token),
// platform admins (session), and tenant OWNERS (session) using
// the /app/admin AI configuration screen. The actual check runs
// through the provider abstraction, so a valid result means the
// key is valid FOR THE SELECTED VENDOR. `provider` defaults to
// anthropic to preserve the original single-vendor contract.

router.post("/validate-key", optionalAuth, async (req, res) => {
  try {
    const { token, api_key, provider } = req.body || {};
    const providerId = typeof provider === "string" && provider.trim().length > 0
      ? provider.trim()
      : "anthropic";

    // Authorization: a valid registration token, a platform admin
    // session, or a tenant OWNER session. Owners validate keys from
    // the admin screen; the same in-memory rate limit that guards
    // token callers guards them (keyed by their subject).
    const isAdmin = req.user && isPlatformAdmin(req.user.sub);
    let isOwner = false;

    if (!isAdmin && req.user && req.user.sub) {
      const authProvider = req.user.provider || inferAuthProvider(req.user.sub);
      if (authProvider) {
        try {
          const tenant = await findTenantByAuthIdentity(authProvider, req.user.sub);
          isOwner = !!tenant && tenant.role === "owner";
        } catch {
          isOwner = false;
        }
      }
      if (isOwner) {
        const ownerKey = `sub:${req.user.sub}`;
        const attempts = validationAttempts.get(ownerKey) || 0;
        if (attempts >= MAX_VALIDATION_ATTEMPTS) {
          return safeError(res, 429, "Too many validation attempts. Please try again later.");
        }
        validationAttempts.set(ownerKey, attempts + 1);
      }
    }

    if (!isAdmin && !isOwner) {
      // Token required for anonymous callers — prevents oracle attacks
      if (!token || typeof token !== "string") {
        return safeError(res, 400, "Registration token required");
      }

      const reg = await validateRegistrationToken(token);
      if (!reg) {
        return safeError(res, 404, "Invalid or expired registration link");
      }

      // Rate limit per token
      const attempts = validationAttempts.get(token) || 0;
      if (attempts >= MAX_VALIDATION_ATTEMPTS) {
        return safeError(res, 429, "Too many validation attempts. Please request a new registration link.");
      }
      validationAttempts.set(token, attempts + 1);
    }

    if (!api_key || typeof api_key !== "string" || api_key.trim().length === 0) {
      return safeError(res, 400, "API key required");
    }

    // Vendor models listing via the abstraction — zero tokens,
    // registry-resolved endpoint, provider auth scheme, egress
    // allowlist enforced before the call.
    let outcome;
    try {
      outcome = await validateProviderKey(providerId, api_key.trim());
    } catch (err) {
      if (err && err.code === "UNKNOWN_PROVIDER") {
        return safeError(res, 400, "Unknown provider");
      }
      platformLog("warn", "provider_models_error", { provider: providerId, code: err?.code || null });
      return safeError(res, 502, "Unable to verify API key with the selected provider");
    }

    if (!outcome.valid) {
      return safeError(res, 401, "Invalid API key");
    }

    res.json({
      valid: true,
      models: outcome.models
    });
  } catch (err) {
    platformLog("error", "key_validation_failed", { error: err.message });
    safeError(res, 500, "Key validation failed");
  }
});

// ══════════════════════════════════════════════════════════════
// Unauthenticated: Complete registration
// ══════════════════════════════════════════════════════════════

router.post("/complete", async (req, res) => {
  try {
    const { token, org_name, api_key, model_id, provider } = req.body || {};
    // Vendor choice (Option 1 ruling): defaults to anthropic so every
    // existing invite and admin-provided-key flow behaves unchanged.
    const providerId = typeof provider === "string" && provider.trim().length > 0
      ? provider.trim()
      : "anthropic";

    // 2.6.1: registration selects the workspace TEXT vendor, so the
    // same availability gate as /api/admin/ai-config applies here.
    // Unknown ids fall through: the key-verify step below keeps its
    // existing "Unknown provider" contract.
    try {
      if (!isTextProviderAvailable(providerId)) {
        return safeError(res, 409, TEXT_GENERATION_NOTICE);
      }
    } catch { /* unknown provider: handled by the verify step below */ }

    // Validate inputs
    if (!token || typeof token !== "string") {
      return safeError(res, 400, "Registration token required");
    }
    if (!org_name || typeof org_name !== "string" || org_name.trim().length < 2) {
      return safeError(res, 400, "Organization name required (min 2 characters)");
    }

    // Validate token is still active
    const reg = await validateRegistrationToken(token);
    if (!reg) {
      return safeError(res, 404, "Invalid or expired registration link");
    }

    // Resolve API key + model: admin-provided takes priority over form
    let finalKey = null;
    let finalModel = null;
    const adminKey = await getRegistrationAdminKey(reg.id);

    if (adminKey) {
      finalKey = adminKey.apiKey;
      finalModel = adminKey.modelId;
    } else {
      if (!api_key || typeof api_key !== "string" || api_key.trim().length === 0) {
        return safeError(res, 400, "API key required");
      }
      // Same guard the card path runs: the key must verify against
      // the CHOSEN vendor before any tenant is born from it.
      try {
        // Ruling (2.4.29): custom endpoints cannot be verified from
        // here and are exempt; every registry vendor still verifies.
        const keyCheck = providerId === "custom"
          ? { valid: true }
          : await validateProviderKey(providerId, api_key.trim());
        if (!keyCheck.valid) return safeError(res, 401, "Invalid API key for the selected provider");
      } catch (err) {
        if (err && err.code === "UNKNOWN_PROVIDER") return safeError(res, 400, "Unknown provider");
        platformLog("warn", "registration_key_verify_error", { provider: providerId, code: err?.code || null });
        return safeError(res, 502, "Unable to verify the API key with the selected provider");
      }
      if (!model_id || typeof model_id !== "string") {
        return safeError(res, 400, "Model selection required");
      }
      finalKey = api_key.trim();
      finalModel = model_id.trim();
    }

    const slug = generateSlug(org_name.trim());
    if (!slug || slug.length < 2) {
      return safeError(res, 400, "Organization name produces an invalid workspace identifier");
    }

    // Atomic: create tenant + mark token claimed
    const tenantId = await completeRegistration(token, slug, org_name.trim());
    if (!tenantId) {
      return safeError(res, 409, "Registration could not be completed. The link may have already been used.");
    }

    // Provision tenant data inside tenant context (RLS-scoped)
    try {
      await withTenant(tenantId, async () => {
        const { setAgentState } = await import("../services/database.js");
        await setAgentState("mode", "manual");
        await setAgentState("corroboration", "disabled");
        // Vendor selection through the SAME primitives the vendor
        // card uses: llmCredentialKeyFor names the credential,
        // llm_provider / llm_model route the orchestrator. The
        // anthropic_model write keeps the pre-abstraction chain
        // coherent, exactly as the card does for anthropic.
        await setAgentState("llm_provider", providerId);
        await setAgentState("llm_model", finalModel);
        if (providerId === "anthropic") {
          await setAgentState("anthropic_model", finalModel);
        }
        const { llmCredentialKeyFor } = await import("../tenant/credential-store.js");
        await storeCredential(llmCredentialKeyFor(providerId), finalKey);

        // Seed catchall feeds — broad-coverage RSS sources that
        // serve any topic the tenant creates
        await seedTenantDefaults();
      });
    } catch (provisionErr) {
      platformLog("error", "registration_provision_partial", {
        tenantId,
        error: provisionErr.message
      });
    }

    // Zero Trust: clear encrypted key from registration row
    if (adminKey) {
      try { await clearRegistrationKey(reg.id); } catch { /* best-effort */ }
    }

    // Create a pending owner invite for the registrant's email.
    // When they log in via Auth0, the resolver claims this invite
    // and creates their owner membership.
    // Invites table has no RLS — platform-level query.
    try {
      await query(
        `INSERT INTO invites (tenant_id, email, email_domain, role, invited_by)
         VALUES ($1, $2, split_part($2, '@', 2), 'owner'::member_role, 'system:registration')`,
        [tenantId, reg.email]
      );
    } catch (inviteErr) {
      platformLog("error", "registration_invite_creation_failed", {
        tenantId,
        email: reg.email,
        error: inviteErr.message
      });
      // Don't fail — the admin can create the invite manually
    }

    platformLog("info", "registration_complete", {
      tenantId,
      slug,
      email: reg.email
    });

    res.json({
      success: true,
      tenantId,
      slug,
      loginUrl: "/auth/login"
    });
  } catch (err) {
    platformLog("error", "registration_complete_failed", { error: err.message });
    safeError(res, 500, "Registration failed");
  }
});

export default router;
