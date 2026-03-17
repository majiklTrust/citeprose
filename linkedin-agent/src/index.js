// ═══════════════════════════════════════════════════════════════
// LinkedIn AI Agent — Main Entry Point
// ═══════════════════════════════════════════════════════════════
// v0.22.1
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
    console.error(`[WARN] dotenv could not load ${envPath}: ${envResult.error.message}`);
    console.error("       Falling back to OS environment variables only.");
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
    console.error(`[FATAL] ${err.message}`);
    console.error("");
    console.error("  Diagnostic:");
    console.error(`    .env path:                   ${envPath}`);
    console.error(`    dotenv loaded:               ${!envResult.error}`);
    console.error(`    ANTHROPIC_API_KEY_ENCRYPTED: ${encryptedKey ? `set (${encryptedKey.length} chars)` : "NOT SET"}`);
    console.error(`    ENCRYPTION_SECRET:           ${encSecret ? `set (${encSecret.length} chars)` : "NOT SET"}`);
    console.error(`    ENCRYPTION_SALT:             ${encSalt ? `set (${encSalt.length} chars)` : "NOT SET"}`);
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

  // Ensure data directory exists
  mkdirSync(path.join(__dirname, "../data"), { recursive: true });

  // ── Initialize ───────────────────────────────────────────────

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  v0.22.1
║                                                           ║
║   Topics: AI Benefits · AI Guardrails                     ║
║           Cyber Incidents · Cyber Advances                ║
║                                                           ║
║   Mode: ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(0)}
╚═══════════════════════════════════════════════════════════╝
`);

  const db = initDatabase();
  setDatabase(db);
  logActivity("info", "agent_started", { mode: process.env.AGENT_MODE || "manual" });

  // ── Express Server ───────────────────────────────────────────

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve the dashboard frontend
  app.use(express.static(path.join(__dirname, "../public")));

  // API routes
  app.use(apiRoutes);

  // ── LinkedIn OAuth Callback ──────────────────────────────────

  app.get("/auth/linkedin/callback", async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.send(`
        <h2>LinkedIn Authorization Failed</h2>
        <p>${error}: ${req.query.error_description}</p>
        <a href="/">Back to Dashboard</a>
      `);
    }

    try {
      const tokens = await exchangeCodeForToken(code);
      process.env.LINKEDIN_ACCESS_TOKEN = tokens.accessToken;

      // Fetch and store profile URN
      const profile = await getProfile(tokens.accessToken);
      process.env.LINKEDIN_PERSON_URN = `urn:li:person:${profile.sub}`;

      res.send(`
        <h2>LinkedIn Connected Successfully!</h2>
        <p>Logged in as: <strong>${profile.name}</strong></p>
        <p>Add these to your <code>.env</code> file:</p>
        <pre>
LINKEDIN_ACCESS_TOKEN=${tokens.accessToken}
LINKEDIN_PERSON_URN=urn:li:person:${profile.sub}
        </pre>
        <p><strong>Token expires in:</strong> ${Math.floor(tokens.expiresIn / 86400)} days</p>
        <br>
        <a href="/">Go to Dashboard →</a>
      `);
    } catch (err) {
      res.status(500).send(`
        <h2>Token Exchange Failed</h2>
        <p>${err.message}</p>
        <a href="/">Back to Dashboard</a>
      `);
    }
  });

  // LinkedIn auth initiation
  app.get("/auth/linkedin", (req, res) => {
    res.redirect(getAuthorizationUrl());
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
  console.error("[FATAL] Startup failed:", err.message);
  process.exit(1);
});
