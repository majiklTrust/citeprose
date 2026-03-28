// ═══════════════════════════════════════════════════════════════
// Mock Auth Provider — For testing only
// ═══════════════════════════════════════════════════════════════
//
// This provider activates when MOCK_AUTH_ENABLED=true is set.
// It implements the full provider interface with no external
// dependencies, allowing registry and middleware tests to run
// without Auth0 or WorkOS credentials.
//
// DO NOT deploy this to production. The registry will refuse
// to load it if NODE_ENV=production (enforced via isConfigured).
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const MOCK_ISSUER = "https://mock-auth.test/";
const MOCK_JWKS_URI = "https://mock-auth.test/.well-known/jwks.json";
const MOCK_AUDIENCE = "https://linkedin-agent-api";
const MOCK_CLIENT_ID = "mock_client_001";

let initialized = false;

const mockProvider = {
  name: "mock",
  type: "oidc",
  priority: 999,
  issuer: MOCK_ISSUER,
  jwksUri: MOCK_JWKS_URI,
  audience: MOCK_AUDIENCE,
  clientId: MOCK_CLIENT_ID,

  isConfigured() {
    if (process.env.NODE_ENV === "production") return false;
    return process.env.MOCK_AUTH_ENABLED === "true";
  },

  async init() {
    initialized = true;
  },

  getRoutes() {
    const { Router } = require("express");
    const router = Router();

    router.get("/auth/mock/login", (req, res) => {
      const state = req.query.state || "";
      const code = crypto.randomBytes(16).toString("hex");
      const callbackUrl = `${process.env.AUTH_CALLBACK_URL || "/auth/mock/callback"}?code=${code}&state=${state}`;
      res.redirect(callbackUrl);
    });

    router.get("/auth/mock/callback", (req, res) => {
      res.json({ message: "Mock auth callback", code: req.query.code });
    });

    router.get("/auth/mock/logout", (req, res) => {
      const returnTo = req.query.returnTo || "/";
      res.redirect(returnTo);
    });

    return router;
  },

  getLoginUrl(state) {
    return `/auth/mock/login?state=${encodeURIComponent(state || "")}`;
  },

  async exchangeCode(code) {
    return {
      accessToken: `mock_access_${crypto.randomBytes(16).toString("hex")}`,
      idToken: `mock_id_${crypto.randomBytes(16).toString("hex")}`,
      expiresIn: 86400,
      tokenType: "Bearer"
    };
  },

  async getUserInfo(token) {
    return {
      sub: "mock_user_001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      provider: "mock"
    };
  },

  getLogoutUrl(returnTo) {
    return `/auth/mock/logout?returnTo=${encodeURIComponent(returnTo || "/")}`;
  },

  async shutdown() {
    initialized = false;
  },

  // Test helpers (not part of the standard interface)
  _isInitialized() { return initialized; }
};

export default mockProvider;
