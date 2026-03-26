// ═══════════════════════════════════════════════════════════════
// LinkedIn AI Agent — Main Entry Point
// ═══════════════════════════════════════════════════════════════
// v0.30.3
//
// Startup sequence (all inside async start()):
//   1. Load .env via dotenv.config() with override:true
//   2. Read encryption vars, decrypt API key (explicit params)
//   3. Scrub secrets from process.env
//   4. Dynamic-import all services (key is in process.env)
//   5. Start Express + scheduler + news monitor
// ═══════════════════════════════════════════════════════════════

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

  // Ensure data directory exists
  mkdirSync(path.join(__dirname, "../data"), { recursive: true });

  // ── Initialize ───────────────────────────────────────────────

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  v0.30.3
║                                                           ║
║   Topics: AI Benefits · AI Guardrails                     ║
║           Cyber Incidents · Cyber Advances                ║
║                                                           ║
║    Env: ${(process.env.NODE_ENV || "NODE_ENV not set").toUpperCase().padEnd(0)}
║   Mode: ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(0)}
╚═══════════════════════════════════════════════════════════╝
`);

  const db = initDatabase();
  setDatabase(db);
  logActivity("info", "agent_started", { mode: process.env.AGENT_MODE || "manual" });

  // ── Express Server ───────────────────────────────────────────

  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");

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
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; " +
      "img-src 'self' data:; " +
      "font-src 'self';"
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // CORS — restrict to configured origins (default: localhost only)
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || `http://localhost:${process.env.DASHBOARD_PORT || 3001}`)
    .split(",").map(o => o.trim());

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS: origin not allowed"));
      }
    }
  }));

  app.use(express.json({ limit: "16kb" }));

  // Serve the dashboard frontend
  app.use(express.static(path.join(__dirname, "../public")));

  // API routes
  app.use(apiRoutes);

  // ── LinkedIn OAuth Callback ──────────────────────────────────

  app.get("/auth/linkedin/callback", async (req, res) => {
    const { code, error, state } = req.query;

    if (!validateOAuthState(state)) {
      return res.status(403).send(`
        <h2>Authorization Failed</h2>
        <p>Invalid or expired OAuth state. Please try again.</p>
        <a href="/">Back to Dashboard</a>
      `);
    }

    if (error) {
      return res.send(`
        <h2>LinkedIn Authorization Failed</h2>
        <p>${escapeHtml(String(error))}: ${escapeHtml(String(req.query.error_description || ""))}</p>
        <a href="/">Back to Dashboard</a>
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
        <a href="/">Go to Dashboard</a>
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
        <a href="/">Back to Dashboard</a>
      `);
    }
  });

  app.get("/auth/linkedin", (req, res) => {
    const state = generateOAuthState();
    res.redirect(getAuthorizationUrl(state));
  });

  // SPA fallback
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
  });

  // ── Start Server & Scheduler ─────────────────────────────────

  const PORT = process.env.DASHBOARD_PORT || 3001;

  app.listen(PORT, () => {
    console.log(`🖥  Dashboard running at http://localhost:${PORT}`);
    console.log(`🔗 LinkedIn auth at  http://localhost:${PORT}/auth/linkedin\n`);

    // Start the scheduling engine
    startScheduler();

    // Start the RSS news monitor
    startMonitor();
  });
}

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

start().catch(err => {
  console.error("[FATAL] Startup failed.");
  process.exit(1);
});
