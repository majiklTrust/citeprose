// // ════════════════════════════════════════════════
// LinkedIn AI Agent — Main Entry Point
// // ════════════════════════════════════════════════
// v2.5.3
//
// Split into three phases:
//   - createApp()  : builds and returns the Express app with
//                    all middleware wired. No listener bound.
//                    Exported so tests can drive the app in-process.
//   - start()      : full production startup — env, decrypt,
//                    services, createApp(), listen, scheduler.
//   - module-guard : start() runs only when this file is the
//                    process entrypoint, not when imported.
//
// The `app` export is populated after createApp() completes
// during start(). Tests that need the app call createApp()
// directly with a prepared context.
// // ════════════════════════════════════════════════
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import express from "express";
import cors from "cors";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The app instance created during start(). Exposed for tests
// that drive the running app via supertest. Null until start()
// or an explicit createApp() call completes.
export let app = null;

// Platform-level logger. Used by code paths that run BEFORE any
// tenant context exists — auth registry initialization, OAuth
// callback handlers, etc. The tenant-scoped logActivity would
// reject these because they have no tenant context to attach the
// log entry to. platformLog writes to the console with a clear
// prefix so the diagnostic trail is preserved without database
// involvement. Kept at module scope so createApp(), start(), and
// buildAppForTests() all share the same implementation.
export function platformLog(level, action, details) {
  const upper = String(level || "info").toUpperCase();
  const payload = details === null || details === undefined ? "" : (
    typeof details === "string" ? details : JSON.stringify(details)
  );
  console.log(`[PLATFORM:${upper}] ${action}${payload ? " " + payload : ""}`);
}

// ═════════════════════════════════════════════════════════════
// createApp — builds the Express app from a context object
// containing the already-imported services. No I/O, no listener.
// Returns the Express app. Callable from tests or start().
// ═════════════════════════════════════════════════════════════
export function createApp(ctx) {
  const {
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes, composeRoutes,
    analyticsRoutes,
    linkedinConnectionRoutes,
    advocacyRoutes,
    imageStudioRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    signMemberState, verifyMemberState, isMemberState,
    buildMemberAuthorizationUrl, fetchConnectionsSize, fetchBasicProfile,
    advocacyGetSelf, advocacyMarkConnected, advocacySnapshotConnectionsSize, advocacySetMemberProfile,
    ADVOCACY_CONSENT_VERSION,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    setAgentState,
    invalidateTokenCache,
    createPlatformAdminRoutes,
    createBillingRoutes
  } = ctx;

  // Server-side owner gate for the /app/admin page. Fail closed:
  // when a caller builds the app without supplying the gate, the
  // page route refuses everyone rather than serving ungated.
  const adminPageGate = Array.isArray(ctx.adminPageGate) && ctx.adminPageGate.length > 0
    ? ctx.adminPageGate
    : [(req, res) => res.status(403).json({ error: "Forbidden" })];

  const instance = express();
  instance.disable("x-powered-by");
  instance.disable("etag");
  instance.set("trust proxy", true);

  // Security headers
  instance.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "connect-src 'self'; " +
      "img-src 'self' data:; " +
      "font-src 'self' https://fonts.gstatic.com;"
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // CORS — explicit, default-deny allowlist. The public origin users load the
  // app from is the source of truth, so seed the list from AUTH0_PUBLIC_ORIGIN
  // and ALLOWED_ORIGINS; this stops CORS drifting away from the login/logout
  // origin. Trailing slashes are stripped because the browser Origin header
  // carries no path while *_ORIGIN env values sometimes do.
  const normalizeOrigin = (s) => (s || "").trim().replace(/\/+$/, "");
  const allowedOrigins = [...new Set([
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map(normalizeOrigin),
    normalizeOrigin(process.env.AUTH0_PUBLIC_ORIGIN),
    normalizeOrigin(getServerAddress().origin),
  ].filter(Boolean))];

  instance.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
        callback(null, true);
      } else {
        platformLog("warn", "cors_origin_rejected", { origin });
        callback(new Error("CORS: origin not allowed"));
      }
    },
    credentials: true,
  }));

  // Payments (2.3.3): the provider webhook needs the RAW body for
  // signature verification, so it mounts BEFORE the json parser.
  // Verification is the provider's job and fails closed; only a
  // signed, well-formed, normalized event reaches the state
  // machine. Replays are absorbed by the audit table's unique ref.
  instance.post("/api/payments/webhook", express.raw({ type: "*/*", limit: "16kb" }), async (req, res) => {
    try {
      const { getPaymentsProvider } = await import("./payments/provider.js");
      const provider = await getPaymentsProvider();
      const event = provider.parseWebhook(req.headers, req.body);
      if (!event) return res.status(401).json({ error: "Webhook rejected" });
      // Verified but not lifecycle-relevant (2.3.6): answer 200 so
      // the processor stops retrying; log the reason for the audit.
      if (event.ignored) {
        console.log(`[payments] webhook ignored: ${event.reason}`);
        return res.json({ ok: true, ignored: true });
      }
      const { applyEvent } = await import("./services/subscription-lifecycle.js");
      const out = await applyEvent(event, provider.name);
      if (out.duplicate) return res.status(200).json({ ok: true, duplicate: true });
      if (out.refused) return res.status(422).json({ error: "Event refused" });
      if (out.raced) return res.status(409).json({ error: "State changed; retry" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[payments] webhook failed:", err.message);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  instance.use(express.json({ limit: "16kb" }));

  // Static file surfaces
  const dashboardHtml = path.join(__dirname, "../public/index.html");
  const alphaDir = path.join(__dirname, "../***REMOVED***");
  const alphaHtml = path.join(alphaDir, "index.html");

  // Static cache policy (1.8.14). ETags are disabled above and the
  // static mounts previously sent no Cache-Control, so browsers
  // applied HEURISTIC freshness (~10% of file age) and CDN edges
  // (Cloudflare dev tunnel, CloudFront prod) applied default TTLs —
  // deploys stayed invisible until caches expired. "no-cache" (not
  // "no-store") forces revalidation on every request while keeping
  // cheap Last-Modified 304s.
  // OWNER-MANAGED TOGGLE: the no-cache header is shipped DISABLED.
  // Uncomment the setHeader line to activate revalidation on all
  // static mounts (see side-effect analysis: rollback mtime trap,
  // CDN origin load, mobile-tunnel latency). All mounts stay wired
  // to this helper so activation is this single line.
  const staticCacheHeaders = (res) => {
    res.setHeader("Cache-Control", "no-cache");
  };

  // Registration page — unauthenticated, token-based access
  instance.use("/app/register", express.static(path.join(__dirname, "../public/register"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // Feeds Manager — accessible to owners and editors
  instance.use("/app/feeds", express.static(path.join(__dirname, "../public/feeds"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // Topics page — accessible to owners and editors (manage_own_topics)
  instance.use("/app/topics", express.static(path.join(__dirname, "../public/topics"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // Analytics page (CLCIS Phase 1). Static shell for all tenant
  // roles; the data behind it is permission-gated at the API layer
  // (view_analytics / sync_analytics), matching the feeds pattern.
  instance.use("/app/analytics", express.static(path.join(__dirname, "../public/analytics"), { index: "index.html", setHeaders: staticCacheHeaders }));
  instance.use("/app/billing", express.static(path.join(__dirname, "../public/billing"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // LinkedIn connection settings page (owner controls; the APIs it
  // calls are manage_linkedin-gated, the shell itself is static).
  instance.use("/app/linkedin", express.static(path.join(__dirname, "../public/linkedin"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // Advocacy page (Phase 2 Step 1): member self panel for all
  // roles plus the owner management section; data behind it is
  // gated at the API layer.
  instance.use("/app/advocacy", express.static(path.join(__dirname, "../public/advocacy"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // Admin page — must be before /app static so /app/admin/ resolves
  // to the admin page, not the SPA fallback. Owner-gated server-side
  // (auth -> tenant -> no dev bypass -> owner permission) BEFORE the
  // static handler; the client-side checkAccess() is UX only.
  instance.use("/app/admin", ...adminPageGate, express.static(path.join(__dirname, "../public/admin"), { index: "index.html", setHeaders: staticCacheHeaders }));

  // Platform admin — super admin only, server-side query execution
  instance.use("/app/platform-admin", express.static(path.join(__dirname, "../public/platform-admin"), { index: "index.html", setHeaders: staticCacheHeaders }));

  instance.use("/app", express.static(path.join(__dirname, "../public"), { index: false, setHeaders: staticCacheHeaders }));
  instance.use(express.static(alphaDir, { index: false, setHeaders: staticCacheHeaders }));

  // ── Auth0 Login / Callback / Logout ────────────────────────
  instance.get("/auth/login", (req, res) => {
    const provider = getDefaultProvider();
    if (!provider) {
      return res.status(503).send(`
        <h2>Authentication Not Available</h2>
        <p>No authentication provider is configured.</p>
        <a href="/">Back to home</a>
      `);
    }
    const state = generateOAuthState();
    const loginUrl = provider.getLoginUrl(state);
    res.redirect(loginUrl);
  });

  instance.get("/auth/callback", async (req, res) => {
    const { code, error, error_description, state } = req.query;

    if (error) {
      const safeError = escapeHtml(String(error));
      const safeDesc = escapeHtml(String(error_description || ""));
      return res.status(400).send(`
        <h2>Authentication Failed</h2>
        <p>${safeError}: ${safeDesc}</p>
        <a href="/">Back to home</a>
      `);
    }

    if (!validateOAuthState(state)) {
      return res.status(403).send(`
        <h2>Authorization Failed</h2>
        <p>Invalid or expired OAuth state. Please try again.</p>
        <a href="/">Back to home</a>
      `);
    }

    const provider = getDefaultProvider();
    if (!provider) {
      return res.status(503).send(`
        <h2>Authentication Not Available</h2>
        <p>No authentication provider is configured.</p>
      `);
    }

    try {
      // exchangeCode returns OAuth tokens only — no user identity.
      // getUserInfo fetches the user identity using the access token.
      // Both calls are required to populate the session payload that
      // createSession expects: { accessToken, refreshToken, expiresIn, user }.
      const tokens = await provider.exchangeCode(code);
      const user = await provider.getUserInfo(tokens.accessToken);
      createSession(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user
      });

      // Log with tenant context — lookup membership for operational visibility.
      // Security: log email domain only (not full address), no tokens.
      let tenantInfo = { slug: null, role: null };
      try {
        const tenant = await findTenantByAuthIdentity(provider.name, user.sub);
        if (tenant) {
          tenantInfo = { slug: tenant.slug, role: tenant.role };
        }
      } catch { /* best-effort — don't block login on log enrichment */ }

      platformLog("info", "user_logged_in", {
        sub: user.sub,
        provider: provider.name,
        emailDomain: user.email ? user.email.split("@")[1] : null,
        tenant: tenantInfo.slug,
        role: tenantInfo.role,
        newUser: !tenantInfo.slug
      });
      return res.redirect("/app");
    } catch (err) {
      platformLog("error", "auth_callback_failed", {
        error: err.message,
        provider: provider.name
      });
      return res.status(500).send(`
        <h2>Authentication Failed</h2>
        <p>An error occurred during authentication. Please try again.</p>
        <a href="/">Back to home</a>
      `);
    }
  });

  instance.get("/auth/logout", (req, res) => {
    clearSession(res);

    const provider = getDefaultProvider();

    if (provider && typeof provider.getLogoutUrl === "function") {
      // Resolve the post-logout destination from the provider's own config
      // (AUTH0_LOGOUT_URI, else AUTH0_PUBLIC_ORIGIN-derived). Passing a
      // getServerAddress()-based returnTo here injected the local bind origin
      // (localhost) behind a proxy and bypassed the public origin.
      const logoutUrl = provider.getLogoutUrl();
      return res.redirect(logoutUrl);
    }

    res.redirect("/");
  });

  // ── LinkedIn OAuth ──────────────────────────────────────────
  instance.get("/auth/linkedin/callback", async (req, res) => {
    const { code, error, state } = req.query;

    // ── Member-leg dispatch (Phase 2 Step 1) ─────────────────
    // Member states are signed (m1. prefix). Verified here FIRST;
    // everything below this block is the tenant path, byte-for-
    // byte as before. A member failure renders a member error
    // page and can never fall through into tenant handling.
    if (isMemberState(state)) {
      const memberFail = (msg) => res.status(403).send(`
        <h2>Advocacy Connection Failed</h2>
        <p>${escapeHtml(msg)}</p>
        <a href="/app/advocacy/">Back to Advocacy</a>
      `);
      try {
        const verdict = verifyMemberState(state);
        if (!verdict.ok || !validateOAuthState(verdict.payload.n)) {
          platformLog("warn", "advocacy_member_state_rejected", {
            reason: verdict.ok ? "nonce_invalid" : verdict.reason
          });
          return memberFail("Invalid or expired connection state. Please try again from the Advocacy page.");
        }
        if (error) {
          return memberFail(`LinkedIn declined the authorization: ${String(error)}`);
        }
        const { sub: memberSub, tenant: tenantId } = verdict.payload;
        await withTenant(tenantId, async () => {
          const tokens = await exchangeCodeForToken(code);
          const profile = await getProfile(tokens.accessToken);
          const personSub = profile?.sub || null;

          const mc = await import("./tenant/member-credential-store.js");
          await mc.storeMemberCredential(memberSub, "linkedin_access_token", tokens.accessToken);
          if (tokens.refreshToken) {
            await mc.storeMemberCredential(memberSub, "linkedin_refresh_token", tokens.refreshToken);
          }
          if (personSub) {
            await mc.storeMemberCredential(memberSub, "linkedin_person_urn", `urn:li:person:${personSub}`);
          }
          await advocacyMarkConnected(memberSub, ADVOCACY_CONSENT_VERSION);

          // Reach snapshot is best-effort: its failure never
          // breaks the connect (FR-P2-05 input only).
          try {
            if (!personSub) throw new Error("no person urn for connections size");
            const size = await fetchConnectionsSize(tokens.accessToken, `urn:li:person:${personSub}`);
            await advocacySnapshotConnectionsSize(memberSub, size);
          } catch (reachErr) {
            platformLog("warn", "advocacy_connections_size_failed", {
              code: reachErr.code || "error"
            });
          }
          // TD-4 inputs, same best-effort discipline: name and
          // headline personalize variants but never gate a connect.
          try {
            const basic = await fetchBasicProfile(tokens.accessToken);
            await advocacySetMemberProfile(memberSub, basic);
          } catch (profErr) {
            platformLog("warn", "advocacy_profile_fetch_failed", {
              code: profErr.code || "error"
            });
          }
          const { logActivity } = await import("./services/database.js");
          await logActivity("info", "advocacy_member_connected", {
            consentVersion: ADVOCACY_CONSENT_VERSION,
            refreshTokenStored: !!tokens.refreshToken
          }, memberSub);
        });
        return res.send(`
          <h2>Personal LinkedIn Connected</h2>
          <p>Your profile is connected for advocacy in manual mode: nothing publishes without your approval.</p>
          <a href="/app/advocacy/">Back to Advocacy</a>
        `);
      } catch (err) {
        platformLog("error", "advocacy_member_connect_failed", { error: err.message });
        return memberFail("The connection could not be completed. Please try again.");
      }
    }

    const stateVerdict = validateOAuthState(state);
    // The origin page rides the validated state; its label keeps
    // the result pages understandable at a glance.
    const backTo = (stateVerdict && stateVerdict.returnTo) || "/app";
    const backLabel = backTo === "/app/linkedin/" ? "Back to LinkedIn Settings" : "Back to Dashboard";
    const backLink = `<a href="${backTo}">${backLabel}</a>`;
    if (!stateVerdict) {
      return res.status(403).send(`
        <h2>Authorization Failed</h2>
        <p>Invalid or expired OAuth state. Please try again.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }

    if (error) {
      return res.send(`
        <h2>LinkedIn Authorization Failed</h2>
        <p>${escapeHtml(String(error))}: ${escapeHtml(String(req.query.error_description || ""))}</p>
        ${backLink}
      `);
    }

    // ── Session-based tenant resolution ──────────────────────
    // The user must be logged in (have a session) to connect
    // LinkedIn. The session identifies who they are; the
    // membership lookup identifies which workspace to store the
    // credentials in. Without this, we don't know whose
    // LinkedIn account this is or where to put the tokens.
    //
    // Dev bypass fallback: when NODE_ENV=dev with DEV_BYPASS_SUB,
    // the user reaches the dashboard via synthetic user injection
    // (no real session cookie). The LinkedIn OAuth redirect lands
    // here without a cookie. Fall back to DEV_BYPASS_SUB so the
    // callback can resolve the tenant and store credentials.
    const session = readSession(req);
    let userSub = session?.user?.sub || null;

    if (!userSub) {
      const devBypassActive = process.env.NODE_ENV === "dev"
        && !!process.env.DEV_BYPASS_ORIGINS;
      const bypassSub = process.env.DEV_BYPASS_SUB;
      if (devBypassActive && bypassSub && bypassSub.trim().length > 0) {
        userSub = bypassSub.trim();
        platformLog("info", "linkedin_callback_dev_bypass", { sub: userSub });
      }
    }

    if (!userSub) {
      return res.status(403).send(`
        <h2>Session Required</h2>
        <p>You must be logged in to connect LinkedIn. Your session may have expired.</p>
        <a href="/auth/login">Log In</a>
      `);
    }

    // Resolve the tenant from the user's auth identity.
    // Infer auth provider from the sub prefix — same logic as
    // the tenant resolver middleware (inferProvider).
    let provider = "auth0";
    if (userSub.startsWith("user_")) provider = "workos";
    let tenant = null;
    try {
      tenant = await findTenantByAuthIdentity(provider, userSub);
    } catch {
      // Lookup failed
    }
    if (!tenant) {
      return res.status(403).send(`
        <h2>No Workspace Found</h2>
        <p>Your account is not associated with a workspace. Contact your administrator.</p>
        ${backLink}
      `);
    }

    try {
      // ── All LinkedIn API calls run inside withTenant ─────────
      // exchangeCodeForToken and getProfile both call logActivity
      // internally, which writes to activity_log via RLS. Without
      // tenant context, logActivity throws "database operation
      // requires tenant context." The withTenant block provides
      // that context for the entire exchange + profile + store
      // sequence.
      await withTenant(tenant.id, async () => {
        const tokens = await exchangeCodeForToken(code);

        let profileName = "(unknown)";
        let personSub = null;
        try {
          const profile = await getProfile(tokens.accessToken);
          personSub = profile.sub;
          profileName = profile.name || "(unknown)";
        } catch (profileErr) {
          platformLog("warn", "oauth_profile_fetch_failed", { error: profileErr.message });
        }

        // Persist credentials — encrypted at rest via AES-256-GCM
        // with a per-tenant derived key.
        await storeCredential("linkedin_access_token", tokens.accessToken);
        // FR-CC-03: persist the refresh token (encrypted, per tenant)
        // and both expiry bookmarks so the proactive refresher can
        // renew before expiry. A missing refresh token is stated
        // loudly, never guessed around.
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (tokens.refreshToken) {
          await storeCredential("linkedin_refresh_token", tokens.refreshToken);
          if (Number.isFinite(tokens.refreshTokenExpiresIn)) {
            await setAgentState("linkedin_refresh_expires_at", String(nowSeconds + tokens.refreshTokenExpiresIn));
          }
        } else {
          platformLog("warn", "linkedin_refresh_token_absent", {
            tenant: tenant.slug,
            note: "OAuth response carried no refresh_token; proactive renewal unavailable until the app is enabled for programmatic refresh"
          });
        }
        if (Number.isFinite(tokens.expiresIn)) {
          await setAgentState("linkedin_token_expires_at", String(nowSeconds + tokens.expiresIn));
        }
        if (personSub) {
          await storeCredential("linkedin_person_urn", `urn:li:person:${personSub}`);
        }

        // Organization discovery, layered on the SAME grant (no
        // second OAuth flow exists or is needed). Exactly one
        // administered org: store it, org mode becomes available.
        // Several: store nothing here; the owner picks on the
        // LinkedIn settings page. None or any failure: state it in
        // the log and move on. Discovery can never break the
        // connect itself.
        let discoveredOrg = null;
        if (personSub) {
          try {
            const { fetchAdministeredOrgs } = await import("./services/linkedin-orgs.js");
            const orgs = await fetchAdministeredOrgs(tokens.accessToken, `urn:li:person:${personSub}`);
            if (orgs.length === 1) {
              await storeCredential("linkedin_org_urn", orgs[0].orgUrn);
              discoveredOrg = orgs[0].orgUrn;
              platformLog("info", "linkedin_org_connected", { tenant: tenant.slug, via: "oauth_discovery" });
            } else {
              platformLog("info", orgs.length === 0 ? "linkedin_org_discovery_none" : "linkedin_org_discovery_multiple", {
                tenant: tenant.slug, count: orgs.length
              });
            }
          } catch (orgErr) {
            platformLog("warn", "linkedin_org_discovery_failed", {
              tenant: tenant.slug, code: orgErr.code || "error"
            });
          }
        }

        platformLog("info", "linkedin_credentials_stored", {
          tenant: tenant.slug,
          user: userSub,
          profileName,
          hasPersonUrn: !!personSub
        });

        // Clear the stale { valid: false } cache entry so the
        // dashboard sees the new credentials immediately instead
        // of waiting for the 10-minute TTL to expire.
        invalidateTokenCache(tenant.id);

        res.send(`
          <h2>LinkedIn Connected Successfully!</h2>
          <p>Logged in as: <strong>${escapeHtml(profileName)}</strong></p>
          ${!personSub ? '<p><em>Profile lookup failed. Token is valid but person URN was not saved. Retry auth to fix.</em></p>' : ''}
          <p>Credentials saved to your workspace.</p>
          ${discoveredOrg ? '<p><strong>Organization page connected:</strong> discovery found exactly one administered org.</p>' : ''}
          <p><strong>Token expires in:</strong> ${Math.floor(tokens.expiresIn / 86400)} days</p>
          <p>Returning to ${backTo === "/app/linkedin/" ? "LinkedIn settings" : "the dashboard"}...</p>
          <br>
          <a href="${backTo}">${backLabel}</a>
          <script>setTimeout(function() { window.location.href = ${JSON.stringify(backTo)}; }, 1500);</script>
        `);
      });
    } catch (err) {
      platformLog("error", "oauth_token_exchange_failed", { error: err.message });
      res.status(500).send(`
        <h2>Token Exchange Failed</h2>
        <p>An error occurred during authentication. Check the activity log.</p>
        ${backLink}
      `);
    }
  });

  instance.get("/auth/linkedin", async (req, res) => {
    // Payments (2.3.4), ruling (3): Connect to LinkedIn is denied
    // outside good standing. Platform admins bypass per (6).
    try {
      const authedUser = req.user || null;
      const { isPlatformAdmin } = await import("./tenant/platform-db.js");
      if (!(authedUser && isPlatformAdmin(authedUser.sub))) {
        // AUDIT F8 (2.4.2): the session user carries authMethod,
        // not a provider field; the wrong key made bearer users'
        // tenants unresolvable and silently skipped this gate.
        const gateProvider = authedUser && authedUser.authMethod === "bearer"
          ? (req.authProvider || "auth0") : "auth0";
        const tenantForGate = authedUser
          ? await (await import("./tenant/platform-db.js")).findTenantByAuthIdentity(gateProvider, authedUser.sub)
          : null;
        if (tenantForGate) {
          const { getSubscription, evaluateAccess } = await import("./services/entitlements.js");
          const verdict = evaluateAccess(await getSubscription(tenantForGate.id), null);
          if (!verdict.allowed) {
            return res.status(402).send(`
              <h2>Subscription Required</h2>
              <p>Connecting LinkedIn requires an active subscription for this workspace.</p>
              <a href="/app">Back to Dashboard</a>
            `);
          }
        }
      }
    } catch (err) {
      console.error("[payments] connect gate failed:", err.message);
      return res.status(403).send(`
        <h2>Access Denied</h2>
        <p>The subscription check could not complete. Try again.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }

    // Return-to preservation: the page that initiated the connect
    // is where the flow lands afterward. The value is allowlisted
    // inside generateOAuthState; anything unexpected collapses to
    // the dashboard.
    const state = generateOAuthState(req.query.returnTo);
    // Per-tenant app credentials (TD-1): resolve the signed-in
    // user's tenant exactly the way the callback does, so the auth
    // URL is built with THAT tenant's client id when one is
    // configured. No session or no tenant: fall through to the
    // platform env default (the callback rejects unauthenticated
    // connects anyway, so nothing weakens).
    const session = readSession(req);
    let userSub = session?.user?.sub || null;
    if (!userSub && process.env.NODE_ENV === "dev"
        && !!process.env.DEV_BYPASS_ORIGINS
        && process.env.DEV_BYPASS_SUB && process.env.DEV_BYPASS_SUB.trim().length > 0) {
      userSub = process.env.DEV_BYPASS_SUB.trim();
    }
    let tenant = null;
    if (userSub) {
      const provider = userSub.startsWith("user_") ? "workos" : "auth0";
      try { tenant = await findTenantByAuthIdentity(provider, userSub); } catch { /* lookup failed */ }
    }
    try {
      const url = tenant
        ? await withTenant(tenant.id, () => getAuthorizationUrl(state))
        : await getAuthorizationUrl(state);
      res.redirect(url);
    } catch (err) {
      // Explicit and logged, instead of falling into the generic
      // catch-all that masks everything as 403 Forbidden.
      platformLog("error", "linkedin_auth_url_failed", { error: err.message });
      res.status(503).send("LinkedIn connection is not configured. Set tenant app credentials in LinkedIn settings, or the platform LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET environment.");
    }
  });

  // ── Member OAuth leg (Phase 2 Step 1, TD-2) ────────────────
  // Same app, same registered redirect URI, the MEMBER scope set
  // (6), and a SIGNED state the shared callback dispatches on.
  // Two steps: GET /auth/linkedin/member renders the consent
  // language (FR-P2-01); the continue link hits /start, which
  // signs the state and redirects to LinkedIn.
  async function resolveMemberContext(req) {
    const session = readSession(req);
    let userSub = session?.user?.sub || null;
    if (!userSub && process.env.NODE_ENV === "dev"
        && !!process.env.DEV_BYPASS_ORIGINS
        && process.env.DEV_BYPASS_SUB && process.env.DEV_BYPASS_SUB.trim().length > 0) {
      userSub = process.env.DEV_BYPASS_SUB.trim();
    }
    if (!userSub) return { error: "not_signed_in" };
    const provider = userSub.startsWith("user_") ? "workos" : "auth0";
    let tenant = null;
    try { tenant = await findTenantByAuthIdentity(provider, userSub); } catch { /* lookup failed */ }
    if (!tenant) return { error: "no_workspace" };
    const self = await withTenant(tenant.id, () => advocacyGetSelf(userSub));
    if (!self) return { error: "not_enabled" };
    return { userSub, tenant };
  }

  instance.get("/auth/linkedin/member", async (req, res) => {
    try {
      const ctx = await resolveMemberContext(req);
      if (ctx.error) {
        return res.status(403).send(`
          <h2>Advocacy connection unavailable</h2>
          <p>${ctx.error === "not_enabled"
            ? "Advocacy has not been enabled for your account. Ask a workspace owner to enable you first."
            : "Sign in to your workspace before connecting a personal LinkedIn profile."}</p>
          <a href="/app/advocacy/">Back to Advocacy</a>
        `);
      }
      res.send(`
        <h2>Connect your personal LinkedIn profile</h2>
        <p><strong>Consent (version ${escapeHtml(ADVOCACY_CONSENT_VERSION)}):</strong>
        by continuing, you authorize this platform to publish posts to YOUR personal
        LinkedIn profile, in your name, only under your own controls: in manual mode
        nothing publishes without your explicit approval of each post; auto mode is
        available only if you yourself opt in later, and you can revoke it or
        disconnect entirely at any time from the Advocacy page. The platform will
        read your basic profile (name, headline, photo) and your first-degree
        connection count. The permissions requested are limited to your identity,
        your own posting, and that connection count; no advertising or organization
        permissions are requested on your personal profile.</p>
        <p><a href="/auth/linkedin/member/start">I consent: continue to LinkedIn</a></p>
        <p><a href="/app/advocacy/">Cancel</a></p>
      `);
    } catch (err) {
      platformLog("error", "advocacy_consent_page_failed", { error: err.message });
      res.status(500).send("<h2>Advocacy connection failed</h2><a href=\"/app/advocacy/\">Back</a>");
    }
  });

  instance.get("/auth/linkedin/member/start", async (req, res) => {
    try {
      const ctx = await resolveMemberContext(req);
      if (ctx.error) {
        return res.status(403).send("<h2>Advocacy connection unavailable</h2><a href=\"/app/advocacy/\">Back</a>");
      }
      const nonce = generateOAuthState();
      const state = signMemberState({ sub: ctx.userSub, tenant: ctx.tenant.id, n: nonce });
      const url = await withTenant(ctx.tenant.id, () => buildMemberAuthorizationUrl(state));
      res.redirect(url);
    } catch (err) {
      platformLog("error", "advocacy_member_auth_url_failed", { error: err.message });
      res.status(503).send("LinkedIn connection is not configured for this workspace.");
    }
  });

  // ── Auth Status Probe ─────────────────────────────────────
  // Used by the alpha homepage (site.js) to decide CTA targets.
  // Does NOT go through requireAuth/optionalAuth middleware —
  // it reads the session directly and computes authRequired by
  // checking both provider state and dev bypass mode.
  instance.get("/auth/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store, private, max-age=0");
    res.setHeader("Pragma", "no-cache");

    // Dev bypass is active when NODE_ENV=dev AND DEV_BYPASS_ORIGINS
    // is set. This matches the two-condition check in middleware.js's
    // isDevBypass(), but without checking the specific request origin
    // — the homepage just needs to know if bypass MODE is active.
    const devBypassActive = process.env.NODE_ENV === "dev"
      && !!process.env.DEV_BYPASS_ORIGINS;

    // Auth is required only when providers are configured AND dev
    // bypass is not active. This aligns with how /api/status
    // computes authRequired (isAuthEnabled() && !req.devBypass).
    const authRequired = isAuthEnabled() && !devBypassActive;

    // Try session first. If no session but dev bypass is active
    // with a synthetic user configured, return that identity so
    // the homepage can show the user greeting and point CTAs to
    // the dashboard.
    const session = readSession(req);
    let user = session?.user || null;
    if (!user && devBypassActive) {
      const sub = process.env.DEV_BYPASS_SUB;
      if (sub && sub.trim().length > 0) {
        user = { name: "Dev Bypass User", email: null, sub: sub.trim() };
      }
    }

    res.json({
      authenticated: !!user,
      authRequired,
      user: user ? { name: user.name || null, email: user.email || null } : null,
    });
  });

  // ── HTML Shell Routes ─────────────────────────────────────
  instance.get("/app", (req, res) => res.sendFile(dashboardHtml));
  instance.get("/app/*", (req, res) => res.sendFile(dashboardHtml));
  instance.get("/", (req, res) => res.sendFile(alphaHtml));

  // Admin API routes — mounted at /api/admin so the router's
  // blanket middleware (requireAuth, resolveTenant, requireNoDevBypass,
  // requirePermission) only runs for admin paths. Without the prefix,
  // the admin middleware intercepts ALL /api/* requests.
  // Must be BEFORE apiRoutes because api.js's route guard 404s
  // unknown /api/* paths.
  instance.use("/api/admin", adminRoutes);

  // Platform admin API — super admin only, cross-tenant operations
  instance.use("/api/platform-admin", createPlatformAdminRoutes());

  // Payments (2.3.5, corrected 2.3.9): billing mounts here inside
  // createApp, where instance exists. The suspended write guard
  // exempts this path so a suspended owner can always reactivate.
  instance.use("/api/billing", createBillingRoutes());

  // Topics API routes — mounted at /api/topics. Blanket middleware
  // requires manage_own_topics (blocks viewers). Per-handler checks
  // enforce manage_topics for global operations.
  instance.use("/api/topics", topicsRoutes);

  // Registration API routes — mounted at /api/register. Mixed auth:
  // /invite requires auth + platform admin, all others are
  // unauthenticated (token-based). Must be before apiRoutes.
  instance.use("/api/register", registrationRoutes);

  // Feeds API routes — mounted at /api/feeds. Blanket middleware
  // requires manage_own_topics (same gate as topics).
  instance.use("/api/feeds", feedsRoutes);

  // Composer API routes — mounted at /api/compose. Own auth+tenant
  // middleware inside the router; decoupled from the Preview path.
  // Must be before apiRoutes (api.js's guard 404s unknown /api/*).
  instance.use("/api/compose", composeRoutes);

  // Analytics API routes (CLCIS Phase 1) mounted at /api/analytics.
  // Blanket requireAuth + resolveTenant inside the router; per-route
  // view_analytics / sync_analytics gates (D5). Must be before
  // apiRoutes (api.js's guard 404s unknown /api/*).
  instance.use("/api/analytics", analyticsRoutes);

  // LinkedIn connection management (publish target toggle, manual
  // tokens, org discovery). Owner-gated inside via manage_linkedin.
  // Must also be before apiRoutes for the same /api/* guard reason.
  instance.use("/api/linkedin", linkedinConnectionRoutes);

  // Advocacy participation (Phase 2 Step 1). Owner management is
  // manage_advocacy-gated inside; member self routes are session-
  // scoped. Must be before apiRoutes for the /api/* guard reason.
  instance.use("/api/advocacy", advocacyRoutes);

  // Image Studio API routes - mounted at /api/image-studio. Own
  // auth + tenant + entitlement("image_studio") + suspendedWriteGuard
  // inside the router. Must be before apiRoutes (api.js guard 404s).
  instance.use("/api/image-studio", imageStudioRoutes);

  // API routes (auth + tenant resolver applied inside apiRoutes)
  instance.use(apiRoutes);

  // API 404 handler — returns JSON so the dashboard can parse it.
  // Must be after apiRoutes but before the generic error handler.
  instance.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler (four params → Express treats as error handler)
  instance.use((err, req, res, next) => {
    if (!res.headersSent) {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  return instance;
}

// ═════════════════════════════════════════════════════════════
// buildAppForTests — dynamic-imports services and returns a
// fully-wired Express app without binding a listener, starting
// the scheduler, or running the news monitor.
//
// Used by the test suite (scripts/testing/test-routes-async*)
// to drive the app in-process via supertest. Not used at
// runtime — start() does the full boot including listener.
//
// Assumes .env is already loaded (dotenv) and required env
// vars (PG*, ENCRYPTION_SECRET, etc.) are set. The test runner
// is responsible for that setup.
// ═════════════════════════════════════════════════════════════
export async function buildAppForTests() {
  const { logActivity, setAgentState }   = await import("./services/database.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { default: adminRoutes,
          createAdminPageGate }          = await import("./routes/admin-api.js");
  const { default: topicsRoutes }        = await import("./routes/topics-api.js");
  const { default: registrationRoutes }  = await import("./routes/registration-api.js");
  const { default: feedsRoutes }          = await import("./routes/feeds-api.js");
  const { getAuthorizationUrl,
          exchangeCodeForToken,
          getProfile,
          invalidateTokenCache }         = await import("./services/linkedin-api.js");
  const { escapeHtml,
          generateOAuthState,
          validateOAuthState }           = await import("./services/security.js");
  const { signMemberState,
          verifyMemberState,
          isMemberState }                = await import("./services/oauth-state.js");
  const { buildMemberAuthorizationUrl,
          fetchConnectionsSize,
          fetchBasicProfile }            = await import("./services/linkedin-member.js");
  const { getSelf: advocacyGetSelf,
          markConnected: advocacyMarkConnected,
          snapshotConnectionsSize: advocacySnapshotConnectionsSize,
          setMemberProfile: advocacySetMemberProfile,
          CONSENT_TEXT_VERSION: ADVOCACY_CONSENT_VERSION } = await import("./services/advocacy-members.js");
  const { initRegistry,
          isAuthEnabled,
          getDefaultProvider }           = await import("./auth/index.js");
  const { createSession,
          readSession,
          clearSession }                 = await import("./auth/session.js");
  const { getServerAddress }             = await import("./services/server-address.js");
  const { withTenant }                   = await import("./db/with-tenant.js");
  const { findTenantByAuthIdentity }     = await import("./tenant/platform-db.js");
  const { storeCredential }              = await import("./tenant/credential-store.js");
  const { default: createBillingRoutes } = await import("./routes/billing-api.js");
  const { default: createPlatformAdminRoutes } = await import("./routes/platform-admin-api.js");
  const { default: composeRoutes }       = await import("./routes/compose-api.js");
  const { default: analyticsRoutes }     = await import("./routes/analytics-api.js");
  const { default: linkedinConnectionRoutes } = await import("./routes/linkedin-connection-api.js");
  const { default: advocacyRoutes }      = await import("./routes/advocacy-api.js");
  const { default: imageStudioRoutes }   = await import("./routes/image-studio-api.js");

  // Use the module-level platformLog so initRegistry's startup
  // events bypass the tenant-scoped logActivity.
  await initRegistry(platformLog);

  return createApp({
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes, composeRoutes,
    analyticsRoutes,
    linkedinConnectionRoutes,
    advocacyRoutes,
    imageStudioRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    signMemberState, verifyMemberState, isMemberState,
    buildMemberAuthorizationUrl, fetchConnectionsSize, fetchBasicProfile,
    advocacyGetSelf, advocacyMarkConnected, advocacySnapshotConnectionsSize, advocacySetMemberProfile,
    ADVOCACY_CONSENT_VERSION,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    setAgentState,
    invalidateTokenCache,
    createPlatformAdminRoutes,
    createBillingRoutes,
    adminPageGate: createAdminPageGate()
  });
}

// ═════════════════════════════════════════════════════════════
// start — full production startup. Loads env, decrypts key,
// imports services, builds the app, starts the listener, kicks
// off the scheduler.
// ═════════════════════════════════════════════════════════════
export async function start() {
  // STEP 1: Load .env
  const envPath = path.resolve(__dirname, "../.env");
  const envResult = dotenv.config({ path: envPath, override: false });
  if (envResult.error) {
    console.error("[WARN] Could not load .env — falling back to OS environment variables.");
  }

  // STEP 2: (removed) Per-tenant Anthropic API keys are now fetched
  // from the credentials table via getAnthropicApiKey() at each use
  // site. There is no global ANTHROPIC_API_KEY to decrypt at startup.
  // ANTHROPIC_API_KEY_ENCRYPTED and ENCRYPTION_SALT can be removed
  // from .env. ENCRYPTION_SECRET must remain — it is the HKDF input
  // keying material used on every per-tenant credential decrypt.

  // STEP 3: Scrub no-longer-needed legacy secrets.
  // ENCRYPTION_SECRET is NOT scrubbed — the credential store reads
  // it on every credential access.
  delete process.env.ENCRYPTION_SALT;
  delete process.env.ANTHROPIC_API_KEY_ENCRYPTED;

  // STEP 4: Dynamic-import services
  const { connectionInfo }               = await import("./db/pool.js");
  const { logActivity, setAgentState }   = await import("./services/database.js");
  const { startScheduler }               = await import("./services/scheduler.js");
  const { startMonitor }                 = await import("./services/news-monitor.js");
  const { startBatchPublisher }          = await import("./services/batch-publisher.js");
  const { startTokenRefresher }          = await import("./services/linkedin-token.js");
  const { startMemberTokenRefresher }    = await import("./services/advocacy-token-refresh.js");
  const { startReachRefresher }          = await import("./services/advocacy-reach.js");
  const { startAnalyticsSync }           = await import("./services/analytics-sync.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { default: adminRoutes,
          createAdminPageGate }          = await import("./routes/admin-api.js");
  const { default: topicsRoutes }        = await import("./routes/topics-api.js");
  const { default: registrationRoutes }  = await import("./routes/registration-api.js");
  const { default: feedsRoutes }          = await import("./routes/feeds-api.js");
  const { getAuthorizationUrl,
          exchangeCodeForToken,
          getProfile,
          invalidateTokenCache }         = await import("./services/linkedin-api.js");
  const { escapeHtml,
          generateOAuthState,
          validateOAuthState }           = await import("./services/security.js");
  const { signMemberState,
          verifyMemberState,
          isMemberState }                = await import("./services/oauth-state.js");
  const { buildMemberAuthorizationUrl,
          fetchConnectionsSize,
          fetchBasicProfile }            = await import("./services/linkedin-member.js");
  const { getSelf: advocacyGetSelf,
          markConnected: advocacyMarkConnected,
          snapshotConnectionsSize: advocacySnapshotConnectionsSize,
          setMemberProfile: advocacySetMemberProfile,
          CONSENT_TEXT_VERSION: ADVOCACY_CONSENT_VERSION } = await import("./services/advocacy-members.js");
  const { initRegistry,
          isAuthEnabled,
          getDefaultProvider }           = await import("./auth/index.js");
  const { createSession,
          readSession,
          clearSession }                 = await import("./auth/session.js");
  const { setBoundAddress,
          getServerAddress,
          getServerUrl }                 = await import("./services/server-address.js");
  const { withTenant }                   = await import("./db/with-tenant.js");
  const { findTenantByAuthIdentity }     = await import("./tenant/platform-db.js");
  const { storeCredential }              = await import("./tenant/credential-store.js");
  const { default: createBillingRoutes } = await import("./routes/billing-api.js");
  const { default: createPlatformAdminRoutes } = await import("./routes/platform-admin-api.js");
  const { default: composeRoutes }       = await import("./routes/compose-api.js");
  const { default: analyticsRoutes }     = await import("./routes/analytics-api.js");
  const { default: linkedinConnectionRoutes } = await import("./routes/linkedin-connection-api.js");
  const { default: advocacyRoutes }      = await import("./routes/advocacy-api.js");
  const { default: imageStudioRoutes }   = await import("./routes/image-studio-api.js");

  mkdirSync(path.join(__dirname, "../data"), { recursive: true });

  // STEP 5: Initialize auth registry.
  //
  // initRegistry fires several logFn() calls at startup for
  // platform-level events (providers loaded, duplicates, init
  // failures, etc.). These happen BEFORE any tenant exists, so
  // the async logActivity — which requires tenant context for
  // the activity_log RLS — would reject. We pass the module-level
  // platformLog (console only) to preserve the diagnostic trail
  // without touching the database. Request-path logging continues
  // to use the real logActivity inside withTenant.
  await initRegistry(platformLog);

  // STEP 6: Build app
  app = createApp({
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes, composeRoutes,
    analyticsRoutes,
    linkedinConnectionRoutes,
    advocacyRoutes,
    imageStudioRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    signMemberState, verifyMemberState, isMemberState,
    buildMemberAuthorizationUrl, fetchConnectionsSize, fetchBasicProfile,
    advocacyGetSelf, advocacyMarkConnected, advocacySnapshotConnectionsSize, advocacySetMemberProfile,
    ADVOCACY_CONSENT_VERSION,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    setAgentState,
    invalidateTokenCache,
    createPlatformAdminRoutes,
    createBillingRoutes,
    adminPageGate: createAdminPageGate()
  });

  // STEP 7: Listen
  const PORT = process.env.DASHBOARD_PORT || 3001;
  const server = app.listen(PORT, () => {
    setBoundAddress(server.address());
    const addr = getServerAddress();
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  2.5.3
║
║           Mode:  ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(0)}
║           Auth:  ${isAuthEnabled() ? "ENABLED" : "DISABLED (no providers configured)"}
║       Database:  ${connectionInfo.database}
║        DB User:  ${connectionInfo.user}
║            App:  ${addr.origin}
║            Env:  ${(process.env.NODE_ENV || "NODE_ENV not set").padEnd(0)}
║           ${process.env.DEV_BYPASS_ORIGINS}
╚═══════════════════════════════════════════════════════════╝
`);
    console.log(`🖥  Homepage at      ${addr.origin}/`);
    console.log(`🖥  Dashboard at     ${addr.origin}/app`);
    console.log(`🔗 LinkedIn auth at ${addr.origin}/auth/linkedin`);
    if (isAuthEnabled()) {
      console.log(`🔐 Auth0 login at   ${addr.origin}/auth/login`);
    }
    console.log("");

    startScheduler();
    // News monitor — iterates all active tenants each hour
    startMonitor();
    // Batch publisher — fires scheduled posts at their set time
    startBatchPublisher();
    // Token refresher: renews LinkedIn tokens before expiry (FR-CC-03).
    // Async (lazy node-cron import); a startup failure logs loudly and
    // must never become an unhandled rejection that kills the server.
    startMemberTokenRefresher().catch((err) =>
      console.error("Advocacy token refresher failed to start:", err.message));
    startReachRefresher().catch((err) =>
      console.error("Advocacy reach refresher failed to start:", err.message));
    startTokenRefresher().catch((err) =>
      platformLog("error", "token_refresher_start_failed", { error: err.message }));
    // Analytics sync: retrieves post metrics + demographics (FR-P1-01)
    startAnalyticsSync().catch((err) =>
      platformLog("error", "analytics_sync_start_failed", { error: err.message }));
  });

  return { app, server };
}

// ═════════════════════════════════════════════════════════════
// Module guard — start() runs only when this file is invoked
// as the process entrypoint (node src/index.js), never when
// another module imports it. Tests import { createApp } without
// triggering startup.
// ═════════════════════════════════════════════════════════════
const isEntrypoint = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");
if (isEntrypoint) {
  start().catch(err => {
    console.error("[FATAL] Startup failed.", err);
    process.exit(1);
  });
}
