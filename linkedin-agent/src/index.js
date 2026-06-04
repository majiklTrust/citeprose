// // ════════════════════════════════════════════════
// LinkedIn AI Agent — Main Entry Point
// // ════════════════════════════════════════════════
// v1.4.34
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
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    invalidateTokenCache,
    createPlatformAdminRoutes
  } = ctx;

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

  instance.use(express.json({ limit: "16kb" }));

  // Static file surfaces
  const dashboardHtml = path.join(__dirname, "../public/index.html");
  const alphaDir = path.join(__dirname, "../***REMOVED***");
  const alphaHtml = path.join(alphaDir, "index.html");

  // Registration page — unauthenticated, token-based access
  instance.use("/app/register", express.static(path.join(__dirname, "../public/register"), { index: "index.html" }));

  // Feeds Manager — accessible to owners and editors
  instance.use("/app/feeds", express.static(path.join(__dirname, "../public/feeds"), { index: "index.html" }));

  // Topics page — accessible to owners and editors (manage_own_topics)
  instance.use("/app/topics", express.static(path.join(__dirname, "../public/topics"), { index: "index.html" }));

  // Admin page — must be before /app static so /app/admin/ resolves
  // to the admin page, not the SPA fallback.
  instance.use("/app/admin", express.static(path.join(__dirname, "../public/admin"), { index: "index.html" }));

  // Platform admin — super admin only, server-side query execution
  instance.use("/app/platform-admin", express.static(path.join(__dirname, "../public/platform-admin"), { index: "index.html" }));

  instance.use("/app", express.static(path.join(__dirname, "../public"), { index: false }));
  instance.use(express.static(alphaDir, { index: false }));

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

    if (!validateOAuthState(state)) {
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
        <a href="/app">Back to Dashboard</a>
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
        <a href="/app">Back to Dashboard</a>
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
        if (personSub) {
          await storeCredential("linkedin_person_urn", `urn:li:person:${personSub}`);
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
          <p><strong>Token expires in:</strong> ${Math.floor(tokens.expiresIn / 86400)} days</p>
          <p>Redirecting to dashboard...</p>
          <br>
          <a href="/app">Go to Dashboard</a>
          <script>setTimeout(function() { window.location.href = "/app"; }, 1500);</script>
        `);
      });
    } catch (err) {
      platformLog("error", "oauth_token_exchange_failed", { error: err.message });
      res.status(500).send(`
        <h2>Token Exchange Failed</h2>
        <p>An error occurred during authentication. Check the activity log.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }
  });

  instance.get("/auth/linkedin", (req, res) => {
    const state = generateOAuthState();
    res.redirect(getAuthorizationUrl(state));
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
  const { logActivity }                  = await import("./services/database.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { default: adminRoutes }         = await import("./routes/admin-api.js");
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
  const { default: createPlatformAdminRoutes } = await import("./routes/platform-admin-api.js");

  // Use the module-level platformLog so initRegistry's startup
  // events bypass the tenant-scoped logActivity.
  await initRegistry(platformLog);

  return createApp({
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    invalidateTokenCache,
    createPlatformAdminRoutes
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
  const { logActivity }                  = await import("./services/database.js");
  const { startScheduler }               = await import("./services/scheduler.js");
  const { startMonitor }                 = await import("./services/news-monitor.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { default: adminRoutes }         = await import("./routes/admin-api.js");
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
  const { default: createPlatformAdminRoutes } = await import("./routes/platform-admin-api.js");

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
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    invalidateTokenCache,
    createPlatformAdminRoutes
  });

  // STEP 7: Listen
  const PORT = process.env.DASHBOARD_PORT || 3001;
  const server = app.listen(PORT, () => {
    setBoundAddress(server.address());
    const addr = getServerAddress();
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  1.4.34
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
