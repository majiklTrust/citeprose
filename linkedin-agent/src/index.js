// // ════════════════════════════════════════════════
// LinkedIn AI Agent — Main Entry Point
// // ════════════════════════════════════════════════
// v0.44.18
//
// Startup sequence (all inside async start()):
//   1. Load .env via dotenv.config() with override:true
//   2. Read encryption vars, decrypt API key (explicit params)
//   3. Scrub secrets from process.env
//   4. Dynamic-import all services (key is in process.env)
//   5. Initialize database, then auth registry
//   6. Start Express + scheduler + news monitor
// // ════════════════════════════════════════════════
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import express from "express";
import cors from "cors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  // ═════════════════════════════════════════════════════════════
  // STEP 1: Load .env (override:true ensures .env always wins
  //         over empty shell variables)
  // ═════════════════════════════════════════════════════════════
  const envPath = path.resolve(__dirname, "../.env");
  const envResult = dotenv.config({ path: envPath, override: true });
  if (envResult.error) {
    console.error("[WARN] Could not load .env — falling back to OS environment variables.");
  }

  // ═════════════════════════════════════════════════════════════
  // STEP 2: Decrypt API key
  // ═════════════════════════════════════════════════════════════
  const { decryptApiKey } = await import("./services/decrypt-key.js");

  // Read values HERE, pass explicitly — no hidden process.env coupling
  const encryptedKey = process.env.ANTHROPIC_API_KEY_ENCRYPTED;
  const encSecret    = process.env.ENCRYPTION_SECRET;
  const encSalt      = process.env.ENCRYPTION_SALT;

  try {
    const apiKey = decryptApiKey(encryptedKey, encSecret, encSalt);
    process.env.ANTHROPIC_API_KEY = apiKey;
    console.log("[OK] API key decrypted.");
  } catch (err) {
    console.error("[FATAL] API key decryption failed. Run: node scripts/verify-key.js");
    process.exit(1);
  }

  // ═════════════════════════════════════════════════════════════
  // STEP 3: Scrub secrets — passphrase and salt have no further
  //         use. Only the decrypted ANTHROPIC_API_KEY remains.
  // ═════════════════════════════════════════════════════════════
  delete process.env.ENCRYPTION_SECRET;
  delete process.env.ENCRYPTION_SALT;
  delete process.env.ANTHROPIC_API_KEY_ENCRYPTED;

  // ═════════════════════════════════════════════════════════════
  // STEP 4: Dynamic-import all services (key is now in process.env)
  // ═════════════════════════════════════════════════════════════
  const { initDatabase, logActivity }    = await import("./services/database.js");
  const { startScheduler }               = await import("./services/scheduler.js");
  const { setDatabase, startMonitor }    = await import("./services/news-monitor.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { getAuthorizationUrl,
          exchangeCodeForToken,
          getProfile }                   = await import("./services/linkedin-api.js");
  const { escapeHtml,
          generateOAuthState,
          validateOAuthState }           = await import("./services/security.js");

  // ── Auth layer imports ─────────────────────────────────────
  const { initRegistry,
          isAuthEnabled,
          getDefaultProvider }           = await import("./auth/index.js");
  const { createSession,
          readSession,
          clearSession }                 = await import("./auth/session.js");

  // ── Server address utility ─────────────────────────────────
  const { setBoundAddress,
          getServerAddress,
          getServerUrl }                 = await import("./services/server-address.js");

  // Ensure data directory exists
  mkdirSync(path.join(__dirname, "../data"), { recursive: true });

  // ═════════════════════════════════════════════════════════════
  // STEP 5: Initialize database, then auth registry
  // Database must be ready before initRegistry because
  // logActivity writes to the activity_log table.
  // ═════════════════════════════════════════════════════════════
  const db = initDatabase();
  setDatabase(db);
  logActivity("info", "agent_started", { mode: process.env.AGENT_MODE || "manual" });

  await initRegistry(logActivity);

  // ── Express Server ───────────────────────────────────────────
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", true); // ALB terminates TLS — req.protocol must read X-Forwarded-Proto

  // Security headers
  app.use((req, res, next) => {
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

  // CORS — restrict to configured origins, default from APP_BASE_URL
  // getServerAddress() returns runtime-detected origin when APP_BASE_URL is unset
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || getServerAddress().origin)
    .split(",").map(o => o.trim());

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS: origin not allowed"));
      }
    },
    credentials: true,
  }));

  app.use(express.json({ limit: "16kb" }));

  // ── Static File Serving ──────────────────────────────────────
  // Two static surfaces, one Express process:
  //
  //   /app/*  → dashboard UI (React SPA from public/)
  //   /*      → marketing homepage (static HTML from ***REMOVED***/)
  //
  // index:false on both mounts because explicit route handlers
  // below serve the HTML shells — not express.static's auto-index.
  const dashboardHtml = path.join(__dirname, "../public/index.html");
  const alphaDir = path.join(__dirname, "../***REMOVED***");
  const alphaHtml = path.join(alphaDir, "index.html");

  app.use("/app", express.static(path.join(__dirname, "../public"), { index: false }));
  app.use(express.static(alphaDir, { index: false }));

  // ── Auth0 Login / Callback / Logout ────────────────────────
  // These routes are defined BEFORE the API router because the
  // API router enforces authentication. The login flow itself
  // cannot require authentication — it IS the authentication.

  app.get("/auth/login", (req, res) => {
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

  app.get("/auth/callback", async (req, res) => {
    const { code, error, error_description, state } = req.query;

    // Auth0 error (user denied consent, misconfigured app, etc.)
    if (error) {
      const safeError = escapeHtml(String(error));
      const safeDesc = escapeHtml(String(error_description || ""));
      return res.status(400).send(`
        <h2>Authentication Failed</h2>
        <p>${safeError}: ${safeDesc}</p>
        <a href="/">Back to home</a>
      `);
    }

    // Validate CSRF state — must happen BEFORE code exchange
    if (!validateOAuthState(state)) {
      return res.status(403).send(`
        <h2>Authentication Failed</h2>
        <p>Invalid or expired authentication state. Please try again.</p>
        <a href="/">Back to home</a>
      `);
    }

    const provider = getDefaultProvider();
    if (!provider) {
      return res.status(503).send(`
        <h2>Authentication Not Available</h2>
        <p>No authentication provider is configured.</p>
        <a href="/">Back to home</a>
      `);
    }

    // Exchange authorization code for tokens
    try {
      const tokens = await provider.exchangeCode(code);

      // Fetch user profile from the provider
      let userInfo = { sub: tokens.sub || "unknown" };
      try {
        userInfo = await provider.getUserInfo(tokens.accessToken || tokens.access_token);
      } catch (profileErr) {
        logActivity("warn", "auth_profile_fetch_failed", { error: profileErr.message });
      }

      // Create encrypted session cookie
      createSession(res, {
        accessToken: tokens.accessToken || tokens.access_token,
        refreshToken: tokens.refreshToken || tokens.refresh_token || null,
        expiresIn: tokens.expiresIn || tokens.expires_in || 3600,
        user: {
          sub: userInfo.sub || userInfo.user_id || "unknown",
          email: userInfo.email || null,
          name: userInfo.name || null,
        }
      });

      // Redirect to dashboard (mounted at /app)
      res.redirect("/app");

    } catch (err) {
      logActivity("error", "auth_code_exchange_failed", {
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

  app.get("/auth/logout", (req, res) => {
    // Clear the session cookie regardless of provider state
    clearSession(res);

    const provider = getDefaultProvider();
    const returnTo = process.env.AUTH0_LOGOUT_URI || getServerAddress().origin;

    if (provider && typeof provider.getLogoutUrl === "function") {
      const logoutUrl = provider.getLogoutUrl(returnTo);
      return res.redirect(logoutUrl);
    }

    // No provider — just redirect home
    res.redirect("/");
  });

  // ── LinkedIn OAuth ──────────────────────────────────────────
  // LinkedIn OAuth is for posting tokens — completely independent
  // from Auth0 dashboard auth. Both must be defined BEFORE
  // app.use(apiRoutes) because the API router enforces auth.

  app.get("/auth/linkedin/callback", async (req, res) => {
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

    try {
      const tokens = await exchangeCodeForToken(code);
      process.env.LINKEDIN_ACCESS_TOKEN = tokens.accessToken;

      let profileName = "(unknown)";
      let personSub = null;
      try {
        const profile = await getProfile(tokens.accessToken);
        personSub = profile.sub;
        profileName = profile.name || "(unknown)";
        process.env.LINKEDIN_PERSON_URN = `urn:li:person:${profile.sub}`;
      } catch (profileErr) {
        logActivity("warn", "oauth_profile_fetch_failed", { error: profileErr.message });
      }

      res.send(`
        <h2>LinkedIn Connected Successfully!</h2>
        <p>Logged in as: <strong>${escapeHtml(profileName)}</strong></p>
        ${!personSub ? '<p><em>Profile lookup failed. Token is valid. Set LINKEDIN_PERSON_URN in .env manually or retry auth.</em></p>' : ''}
        <p>Token saved to session. Add credentials to your <code>.env</code> file via the server console.</p>
        <p><strong>Token expires in:</strong> ${Math.floor(tokens.expiresIn / 86400)} days</p>
        <br>
        <a href="/app">Go to Dashboard</a>
      `);

      console.log("[AUTH] LinkedIn token obtained. Add to .env:");
      console.log(`  LINKEDIN_ACCESS_TOKEN=${tokens.accessToken}`);
      if (personSub) {
        console.log(`  LINKEDIN_PERSON_URN=urn:li:person:${personSub}`);
      } else {
        console.log("  LINKEDIN_PERSON_URN=(profile fetch failed — set manually or retry auth)");
      }
    } catch (err) {
      logActivity("error", "oauth_token_exchange_failed", { error: err.message });
      res.status(500).send(`
        <h2>Token Exchange Failed</h2>
        <p>An error occurred during authentication. Check the activity log.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }
  });

  app.get("/auth/linkedin", (req, res) => {
    const state = generateOAuthState();
    res.redirect(getAuthorizationUrl(state));
  });

  // ── Auth Status Probe ─────────────────────────────────────
  // Public endpoint consumed by the alpha marketing homepage.
  // Returns whether the caller holds a valid session and, if so,
  // the minimum display fields for a "Welcome back" greeting.
  // Lives here alongside the other /auth/* routes — NOT in
  // api.js — so it never enters the API router and never
  // triggers requireAuth.
  //
  // Security notes:
  //   • Reads the session cookie directly via readSession() —
  //     no middleware, no req.user gating.
  //   • Returns only name and email. The stable user identifier
  //     (sub) is deliberately NOT exposed.
  //   • Cache-Control: no-store prevents intermediaries from
  //     returning a stale auth state to a different user.
  app.get("/auth/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store, private, max-age=0");
    res.setHeader("Pragma", "no-cache");
    const session = readSession(req);
    const user = session?.user || null;
    res.json({
      authenticated: !!user,
      user: user ? { name: user.name || null, email: user.email || null } : null,
    });
  });

  // ── HTML Shell Routes ─────────────────────────────────────
  // IMPORTANT: These MUST be defined BEFORE app.use(apiRoutes).
  // The API router is mounted at root (no path prefix) and its
  // requireAuth middleware runs on every request that enters it.
  // If these routes were defined after the API router, requests
  // to / and /app from unauthenticated visitors would hit
  // requireAuth and get a 401 instead of the HTML page.

  // Dashboard SPA — /app and any client-side route under /app/*
  app.get("/app", (req, res) => res.sendFile(dashboardHtml));
  app.get("/app/*", (req, res) => res.sendFile(dashboardHtml));

  // Marketing homepage — ***REMOVED***/index.html at the root
  app.get("/", (req, res) => res.sendFile(alphaHtml));

  // API routes (auth enforcement is applied inside apiRoutes)
  app.use(apiRoutes);

  // ── Error handler ──────────────────────────────────────────
  // Catches errors thrown by middleware (e.g., CORS rejection).
  // Without this, Express's default handler sends the full stack
  // trace to the client when NODE_ENV is not 'production'.
  // Four parameters mark this as an error handler for Express.
  app.use((err, req, res, next) => {
    if (!res.headersSent) {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  // ── Start Server & Scheduler ─────────────────────────────────
  const PORT = process.env.DASHBOARD_PORT || 3001;
  const server = app.listen(PORT, () => {
    // Register the bound address for runtime detection
    setBoundAddress(server.address());
    const addr = getServerAddress();

    // ── Startup Banner ─────────────────────────────────────────
    // Printed AFTER app.listen() so server address is known,
    // and AFTER initRegistry() so isAuthEnabled() is accurate.
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  v0.44.18
║                                                           ║
║   Topics: AI Benefits · AI Guardrails                     ║
║           Cyber Incidents · Cyber Advances                ║
║                                                           ║
║    Env: ${(process.env.NODE_ENV || "NODE_ENV not set").padEnd(0)}
║   Mode: ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(0)}
║   Auth: ${isAuthEnabled() ? "ENABLED" : "DISABLED (no providers configured)"}
║    App: ${addr.origin}
╚═══════════════════════════════════════════════════════════╝
`);
    console.log(`🖥  Homepage at      ${addr.origin}/`);
    console.log(`🖥  Dashboard at     ${addr.origin}/app`);
    console.log(`🔗 LinkedIn auth at ${addr.origin}/auth/linkedin`);
    if (isAuthEnabled()) {
      console.log(`🔐 Auth0 login at   ${addr.origin}/auth/login`);
    }
    console.log("");

    // Start the scheduling engine
    startScheduler();

    // Start the RSS news monitor
    startMonitor();
  });
}

// // ════════════════════════════════════════════════
// Run
// // ════════════════════════════════════════════════
start().catch(err => {
  console.error("[FATAL] Startup failed.");
  process.exit(1);
});
