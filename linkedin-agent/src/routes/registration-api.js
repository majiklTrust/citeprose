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

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { platformLog } from "../services/platform-log.js";
import {
  isPlatformAdmin,
  createRegistrationInvite,
  validateRegistrationToken,
  activateRegistrationToken,
  completeRegistration
} from "../tenant/platform-db.js";
import { withTenant } from "../db/with-tenant.js";
import { query } from "../db/pool.js";
import { storeCredential } from "../tenant/credential-store.js";

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

// ── Helper: safe error — never leak internals ────────────────

function safeError(res, status, message) {
  return res.status(status).json({ error: message });
}

// ══════════════════════════════════════════════════════════════
// Authenticated: Create registration invite (platform admin)
// ══════════════════════════════════════════════════════════════

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.post("/invite", requireAuth, resolveTenant, async (req, res) => {
  try {
    // Platform admin check
    if (!isPlatformAdmin(req.user.sub)) {
      return safeError(res, 403, "Permission denied");
    }

    const { email } = req.body || {};
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return safeError(res, 400, "Valid email address required");
    }

    const invite = await createRegistrationInvite(email.trim(), req.user.sub);

    // Build the registration URL and email template
    const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
    const brandName = process.env.BRAND_NAME || "LinkedIn AI Content Agent";
    const registerUrl = `${origin}/app/register#token=${invite.token}`;

    const emailSubject = `Your ${brandName} workspace is ready to set up`;

    const emailBody = [
      `Hello,`,
      ``,
      `Your workspace on ${brandName} is ready for setup. This platform helps you create researched, professional LinkedIn content powered by AI.`,
      ``,
      `To get started, click the link below and follow the registration steps:`,
      `${registerUrl}`,
      ``,
      `What you'll need:`,
      `  • An Anthropic API key (https://console.anthropic.com/settings/keys)`,
      `  • A name for your workspace`,
      ``,
      `This link expires on ${new Date(invite.expires_at).toLocaleString()} and can only be used once.`,
      ``,
      `If you have any questions or did not expect this invitation, please contact your account administrator.`,
      ``,
      `Welcome aboard,`,
      `The ${brandName} Team`
    ].join("\n");

    platformLog("info", "registration_invite_created", {
      email: invite.email,
      invitedBy: req.user.sub,
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
      expiresAt: reg.expires_at
    });
  } catch (err) {
    platformLog("error", "registration_init_failed", { error: err.message });
    safeError(res, 500, "Registration initialization failed");
  }
});

// ══════════════════════════════════════════════════════════════
// Unauthenticated: Validate Anthropic API key + list models
// ══════════════════════════════════════════════════════════════

router.post("/validate-key", async (req, res) => {
  try {
    const { token, api_key } = req.body || {};

    // Token required — prevents oracle attacks
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

    if (!api_key || typeof api_key !== "string" || api_key.trim().length === 0) {
      return safeError(res, 400, "API key required");
    }

    // Call Anthropic /v1/models — zero tokens, validates key + returns models
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": api_key.trim(),
        "anthropic-version": "2023-06-01"
      }
    });

    if (response.status === 401) {
      return safeError(res, 401, "Invalid API key");
    }

    if (!response.ok) {
      platformLog("warn", "anthropic_models_error", { status: response.status });
      return safeError(res, 502, "Unable to verify API key with Anthropic");
    }

    const data = await response.json();
    const models = (data.data || [])
      .filter(m => m.id && m.id.startsWith("claude-"))
      .map(m => ({
        id: m.id,
        name: m.display_name || m.id,
        created: m.created_at || null
      }))
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""));

    res.json({
      valid: true,
      models
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
    const { token, org_name, api_key, model_id } = req.body || {};

    // Validate inputs
    if (!token || typeof token !== "string") {
      return safeError(res, 400, "Registration token required");
    }
    if (!org_name || typeof org_name !== "string" || org_name.trim().length < 2) {
      return safeError(res, 400, "Organization name required (min 2 characters)");
    }
    if (!api_key || typeof api_key !== "string" || api_key.trim().length === 0) {
      return safeError(res, 400, "Anthropic API key required");
    }
    if (!model_id || typeof model_id !== "string") {
      return safeError(res, 400, "Model selection required");
    }

    // Validate token is still active
    const reg = await validateRegistrationToken(token);
    if (!reg) {
      return safeError(res, 404, "Invalid or expired registration link");
    }

    const slug = generateSlug(org_name.trim());
    if (!slug || slug.length < 2) {
      return safeError(res, 400, "Organization name produces an invalid workspace identifier");
    }

    // Atomic: create tenant + mark token claimed
    // completeRegistration uses SELECT FOR UPDATE to prevent races
    const tenantId = await completeRegistration(token, slug, org_name.trim());
    if (!tenantId) {
      return safeError(res, 409, "Registration could not be completed. The link may have already been used.");
    }

    // Provision tenant data inside tenant context (RLS-scoped)
    try {
      await withTenant(tenantId, async () => {
        // Agent state defaults
        const { setAgentState } = await import("../services/database.js");
        await setAgentState("mode", "manual");
        await setAgentState("corroboration", "enabled");

        // Encrypted credentials
        await storeCredential("anthropic_api_key", api_key.trim());
        await storeCredential("anthropic_model", model_id.trim());
      });
    } catch (provisionErr) {
      // Tenant was created but provisioning failed.
      // Log the error but don't fail the registration —
      // the tenant exists and can be fixed by the admin.
      platformLog("error", "registration_provision_partial", {
        tenantId,
        error: provisionErr.message
      });
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
