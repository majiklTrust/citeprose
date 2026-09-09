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
import { isTextProviderAvailable, textGenerationNotice, TEXT_GENERATION_NOTICE } from "../llm/registry.js";
import { validateModelProviderSelection, isModelProviderSelectionError } from "../llm/model-provider-selection.js";
import { withTenant } from "../db/with-tenant.js";
import { query } from "../db/pool.js";
import { storeCredential } from "../tenant/credential-store.js";
import { seedTenantDefaults } from "../tenant/seed-defaults.js";
import { DEFAULT_MODE } from "../automation/automation-mode.js";

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

    const { email, apiKey, model_id } = req.body || {};
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return safeError(res, 400, "Valid email address required");
    }

    // If admin is providing an API key, validate the WHOLE selection
    // first, through the same shared validator the /app/admin card
    // uses (4.25111.17, closing refactor item 8). Before this, the
    // key was verified with the Model Provider but the model string
    // was stored with a trim and nothing else, so a typo accepted on
    // this form surfaced days later inside the new tenant's first
    // scheduled runs. Registration provisioning stays on the
    // platform default Model Provider, anthropic. Zero token cost on
    // a refused selection: the model check is a registry read and
    // runs before the key call.
    let validatedKey = null;
    let validatedModel = null;
    if (apiKey && typeof apiKey === "string" && apiKey.trim().length > 0) {
      if (!model_id || typeof model_id !== "string") {
        return safeError(res, 400, "Model selection required when providing an API key");
      }
      try {
        await validateModelProviderSelection({
          providerId: "anthropic", modelId: model_id, apiKey: apiKey.trim()
        });
      } catch (err) {
        if (!isModelProviderSelectionError(err)) throw err;
        if (err.code === "UNKNOWN_MODEL") {
          return safeError(res, 400, "Unknown model for the selected Model Provider");
        }
        if (err.code === "KEY_VALIDATION_UNAVAILABLE") {
          platformLog("warn", "provider_models_error", { provider: "anthropic", code: err.causeCode });
          return safeError(res, 502, "Unable to verify API key with the selected provider");
        }
        // KEY_INVALID (anthropic is always known and available here)
        return safeError(res, 401, "Invalid API key");
      }
      validatedKey = apiKey.trim();
      validatedModel = model_id.trim();
    }

    // 3.25111.2: DDL 09.2 enforces one LIVE registration per email
    // at the storage engine, and that invariant binds this admin
    // path too. A duplicate is a named 409 describing the caller's
    // own state, never an opaque 500 (the mapping 09.2's deployment
    // note calls for).
    let invite;
    try {
      invite = await createRegistrationInvite(
        email.trim(), req.user.sub, validatedKey, validatedModel
      );
    } catch (err) {
      if (err && err.code === "23505") {
        platformLog("info", "registration_invite_duplicate", {
          admin: req.user.sub, emailDomain: email.trim().split("@")[1] || null
        });
        return res.status(409).json({
          error: "A live registration link already exists for this email address. Wait for it to expire, or clear it with the platform-admin registration tools, then reissue.",
          code: "REGISTRATION_EXISTS"
        });
      }
      throw err;
    }

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
      : `  • A name for your workspace\n  • A Model Provider API key:\n    - https://console.anthropic.com/settings/keys\n    - https://platform.openai.com/api-keys\n    - https://console.x.ai/\n`;

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
// Authenticated: SELF-SERVICE registration invite (2.5.111 line)
// ══════════════════════════════════════════════════════════════
// The self-service trigger for the SAME New Tenant Registration
// workflow the platform-admin card starts, with the trust model
// inverted: the admin's authority is replaced by the visitor's own
// IDP-verified identity.
//
// Security posture by category (ruled with the design):
//   Resource abuse   no anonymous surface; the DURABLE bounds (one
//                    live registration per email, lifetime cap per
//                    subject) are adjudicated ATOMICALLY in the
//                    database by self-registration-store, so they
//                    hold across instances, restarts, and races.
//                    The in-memory counter below is only a cheap
//                    local burst filter, never the real bound.
//   Money exposure   unchanged: a shell tenant; checkout still
//                    binds to the tenant the wizard creates.
//   Identity trust   the email comes ONLY from the verified
//                    session; unverified email or a synthetic
//                    dev-bypass identity is refused outright.
//   Surface area     the admin key path is structurally
//                    unreachable, the route reads NO body fields,
//                    and a kill switch closes the whole surface.
function isSelfRegistrationEnabled() {
  return (process.env.SELF_REGISTRATION || "on") !== "off";
}
// Hardcoded default flagged per project convention; env-overridable.
function getSelfInviteBurstCap() {
  const n = parseInt(process.env.SELF_REGISTRATION_BURST_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}
// Burst filter (F1 resolution, optimized): a DECAYING sliding
// window, consulted only after every in-memory gate has passed,
// so a slot is consumed exclusively by a request that would
// otherwise reach the database. Refusals that cost nothing
// (unverified email, synthetic identity, kill switch) consume
// nothing, so a confused user can never lock themselves out; the
// window self-heals in BURST_WINDOW_MS, and the table is bounded
// so it can never become a slow leak. Per-instance by design; the
// durable caps live in the store's atomic adjudication.
const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_TABLE_MAX = 5000;
const selfInviteAttempts = new Map(); // sub -> [attempt timestamps]
function overSelfInviteBurst(sub) {
  const now = Date.now();
  const prior = selfInviteAttempts.get(sub);
  const seen = prior ? prior.filter((t) => now - t < BURST_WINDOW_MS) : [];
  if (seen.length >= getSelfInviteBurstCap()) {
    selfInviteAttempts.set(sub, seen);
    return true; // over cap: refuse WITHOUT extending the window
  }
  seen.push(now);
  if (!prior && selfInviteAttempts.size >= BURST_TABLE_MAX) {
    selfInviteAttempts.delete(selfInviteAttempts.keys().next().value);
  }
  selfInviteAttempts.set(sub, seen);
  return false;
}

router.post("/self-invite", requireAuth, async (req, res) => {
  try {
    if (!isSelfRegistrationEnabled()) {
      // F5 resolution: the kill switch is an incident-response
      // control; every refusal it issues must be visible in the
      // platform log, or "disabled and quiet" reads like "broken".
      platformLog("info", "self_registration_refused", {
        sub: (req.user && req.user.sub) || null,
        code: "SELF_REGISTRATION_DISABLED"
      });
      return res.status(403).json({ error: "Self-service setup is not available.", code: "SELF_REGISTRATION_DISABLED" });
    }
    // Zero Trust: synthetic identities never mint tenants.
    if (req.devBypass || req.authSkipped) {
      return safeError(res, 403, "Self-service setup requires a real login");
    }
    if (!req.user || !req.user.sub) {
      return safeError(res, 401, "Sign in before setting up a workspace");
    }
    const sub = req.user.sub;

    // Verified email from the SESSION, never the body.
    if (req.user.emailVerified !== true) {
      return safeError(res, 403, "Verify your email address first, then log in again to set up your workspace.");
    }
    const email = typeof req.user.email === "string" ? req.user.email.trim() : "";
    if (!email || !email.includes("@")) {
      return safeError(res, 403, "Your login carries no email address; a workspace cannot be set up for it.");
    }

    // Burst filter LAST among the gates (F1): only a request that
    // passed every check above and would now reach the database
    // consumes a slot from the decaying window.
    if (overSelfInviteBurst(sub)) {
      return safeError(res, 429, "Too many setup attempts. Please try again in a few minutes.");
    }

    // One atomic adjudication: eligibility and mint in ONE statement
    // (no check-then-insert race, instance-independent).
    const { attemptSelfRegistration, SELF_REG_OUTCOME } = await import("../tenant/self-registration-store.js");
    const verdict = await attemptSelfRegistration(email, sub);

    const emailDomain = email.split("@")[1] || null;
    const granting = [SELF_REG_OUTCOME.CREATED, SELF_REG_OUTCOME.REISSUED, SELF_REG_OUTCOME.ROTATED];
    if (granting.includes(verdict.outcome)) {
      const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
      platformLog("info", "self_registration_invite_created", {
        sub, emailDomain, mode: verdict.outcome, expiresAt: verdict.expiresAt
      });
      // URL returns ONLY to the verified email owner, in the same
      // authenticated response. ROTATED = a stale self link for the
      // same verified email was atomically revoked and replaced.
      return res.status(verdict.outcome === SELF_REG_OUTCOME.REISSUED ? 200 : 201).json({
        registerUrl: `${origin}/app/register#token=${verdict.token}`,
        expiresAt: verdict.expiresAt,
        reissued: verdict.outcome === SELF_REG_OUTCOME.REISSUED
      });
    }
    if (verdict.outcome === SELF_REG_OUTCOME.RETRY) {
      platformLog("info", "self_registration_refused", { sub, emailDomain, code: verdict.outcome });
      return res.status(409).json({ error: "Setup is being prepared in another window. Try the button again.", code: "SETUP_RACE" });
    }

    platformLog("info", "self_registration_refused", { sub, emailDomain, code: verdict.outcome });
    // Every refusal describes only the CALLER'S own state.
    if (verdict.outcome === SELF_REG_OUTCOME.ALREADY_MEMBER) {
      return res.status(409).json({ error: "This login already belongs to a workspace.", code: "ALREADY_MEMBER" });
    }
    if (verdict.outcome === SELF_REG_OUTCOME.INVITE_PENDING) {
      return res.status(409).json({ error: "An invitation is already waiting for this email address. Log out and back in to accept it.", code: "INVITE_PENDING" });
    }
    if (verdict.outcome === SELF_REG_OUTCOME.REGISTRATION_EXISTS) {
      return res.status(409).json({ error: "A setup link for this email was already issued by your administrator. Use that link, or wait for it to expire.", code: "REGISTRATION_EXISTS" });
    }
    if (verdict.outcome === SELF_REG_OUTCOME.RATE_LIMITED) {
      return res.status(429).json({ error: "This login has reached its workspace setup limit. Contact support.", code: "RATE_LIMITED" });
    }
    return safeError(res, 500, "Workspace setup could not start");
  } catch (err) {
    platformLog("error", "self_registration_invite_failed", { error: err.message });
    safeError(res, 500, "Workspace setup could not start");
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
// Validate a Model Provider API key + list models (provider-aware)
// ══════════════════════════════════════════════════════════════
// One validation path for every caller: registration (token),
// platform admins (session), and tenant OWNERS (session) using
// the /app/admin AI configuration screen. The actual check runs
// through the provider abstraction, so a valid result means the
// key is valid FOR THE SELECTED MODEL PROVIDER. `provider` defaults to
// anthropic to preserve the original single-Model Provider contract.

router.post("/validate-key", optionalAuth, async (req, res) => {
  try {
    const { token, apiKey, provider } = req.body || {};
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

    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return safeError(res, 400, "API key required");
    }

    // Model Provider models listing via the abstraction, zero tokens,
    // registry-resolved endpoint, provider auth scheme, egress
    // allowlist enforced before the call.
    let outcome;
    try {
      outcome = await validateProviderKey(providerId, apiKey.trim());
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
    const { token, org_name, apiKey, model_id, provider } = req.body || {};
    // Model Provider choice (Option 1 ruling): defaults to anthropic so every
    // existing invite and admin-provided-key flow behaves unchanged.
    const providerId = typeof provider === "string" && provider.trim().length > 0
      ? provider.trim()
      : "anthropic";

    // 2.6.1: registration selects the workspace TEXT Model Provider, so the
    // same availability gate as /api/admin/ai-config applies here.
    // Unknown ids fall through: the key-verify step below keeps its
    // existing "Unknown provider" contract. 2.6.5: the refusal
    // carries the Model Provider's OWN notice (per-Model Provider data), with the
    // shared notice as the fallback.
    try {
      if (!isTextProviderAvailable(providerId)) {
        return safeError(res, 409, textGenerationNotice(providerId) || TEXT_GENERATION_NOTICE);
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
      // The invite's selection was validated when the administrator
      // created it, and the registry can change between creation and
      // redemption, so the model resolves AGAIN at the moment a
      // tenant is about to be born from it (4.25111.17).
      if (adminKey.modelId) {
        try {
          await validateModelProviderSelection({
            providerId: "anthropic", modelId: adminKey.modelId
          });
        } catch (err) {
          if (isModelProviderSelectionError(err) && err.code === "UNKNOWN_MODEL") {
            return safeError(res, 409,
              "The model on this invitation is no longer available. Ask your administrator for a new invitation.");
          }
          throw err;
        }
      }
      finalKey = adminKey.apiKey;
      finalModel = adminKey.modelId;
    } else {
      if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
        return safeError(res, 400, "API key required");
      }
      if (!model_id || typeof model_id !== "string") {
        return safeError(res, 400, "Model selection required");
      }
      // The SAME guard the /app/admin card runs, from the SAME
      // module (4.25111.17): provider and model must resolve in the
      // registry and the key must verify against the CHOSEN Model
      // Provider before any tenant is born from it. Ruling (2.4.29)
      // preserved: custom endpoints cannot be key-verified from here
      // and are exempt; their model must still resolve, exactly as
      // the card requires.
      try {
        await validateModelProviderSelection({
          providerId, modelId: model_id, apiKey: apiKey.trim(),
          skipKeyValidation: providerId === "custom"
        });
      } catch (err) {
        if (!isModelProviderSelectionError(err)) throw err;
        if (err.code === "UNKNOWN_PROVIDER") return safeError(res, 400, "Unknown provider");
        if (err.code === "TEXT_PROVIDER_COMING_SOON") return safeError(res, 409, err.message);
        if (err.code === "UNKNOWN_MODEL") {
          return safeError(res, 400, "Unknown model for the selected Model Provider");
        }
        if (err.code === "KEY_INVALID") return safeError(res, 401, "Invalid API key for the selected provider");
        // KEY_VALIDATION_UNAVAILABLE
        platformLog("warn", "registration_key_verify_error", { provider: providerId, code: err.causeCode });
        return safeError(res, 502, "Unable to verify the API key with the selected provider");
      }
      finalKey = apiKey.trim();
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
        // 4.25111.60 (Decision 3): a new tenant starts with automation
        // off. DEFAULT_MODE is 'manual' in the three-state vocabulary
        // (nothing automated), not the old 'manual' that generated
        // on cadence; the interpreter owns the string.
        await setAgentState("mode", DEFAULT_MODE);
        await setAgentState("corroboration", "disabled");
        // Model Provider selection through the SAME primitives the Model Provider
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
      try { await clearRegistrationKey(reg.id); } catch (err) {
        // best-effort as before. 4.25111.58: recorded, because an
        // encrypted admin key left behind in the row is a hygiene
        // failure someone must clean up.
        platformLog("warn", "registration_key_clear_failed", { registrationId: reg.id, error: err && err.message ? err.message : String(err) });
      }
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

    // 4.25111.78: a purchase that began on the public pricing page
    // settles here. A paid purchase row for this registration (or for
    // this login) becomes the new tenant's subscription now; an unpaid
    // one is bound to the tenant so the processor's later message
    // lands on it. Never fails the registration: the workspace exists
    // either way and the subscription can still arrive by message.
    let landing = null;
    try {
      const { settlePurchaseForRegistration } = await import("../services/purchase-settlement.js");
      const settled = await settlePurchaseForRegistration(reg, tenantId);
      landing = settled && settled.landing ? settled.landing : null;
    } catch (settleErr) {
      platformLog("error", "registration_purchase_settle_failed", { tenantId, registrationId: reg.id, error: settleErr && settleErr.message });
    }

    platformLog("info", "registration_complete", {
      tenantId,
      slug,
      email: reg.email,
      purchased: !!landing
    });

    res.json({
      success: true,
      tenantId,
      slug,
      loginUrl: "/auth/login",
      landing: landing || "/app"
    });
  } catch (err) {
    platformLog("error", "registration_complete_failed", { error: err.message });
    safeError(res, 500, "Registration failed");
  }
});

export default router;
