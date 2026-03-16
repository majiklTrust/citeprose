// ═══════════════════════════════════════════════════════════════
// LinkedIn AI Agent — Main Entry Point
// ═══════════════════════════════════════════════════════════════

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

import { initDatabase, logActivity } from "./services/database.js";
import { startScheduler } from "./services/scheduler.js";
import { setDatabase, startMonitor } from "./services/news-monitor.js";
import apiRoutes from "./routes/api.js";
import { getAuthorizationUrl, exchangeCodeForToken, getProfile } from "./services/linkedin-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
mkdirSync(path.join(__dirname, "../data"), { recursive: true });

// ── Initialize ───────────────────────────────────────────────

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  v1.10.4               ║
║                                                           ║
║   Topics: AI Benefits · AI Guardrails                     ║
║           Cyber Incidents · Cyber Advances                ║
║                                                           ║
║   Mode: ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(48)}║
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
