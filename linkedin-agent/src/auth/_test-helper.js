// ═══════════════════════════════════════════════════════════════
// JWT Test Helper — Generates real signed tokens for testing
// ═══════════════════════════════════════════════════════════════
//
// Creates an RSA key pair, serves the public key as JWKS on a
// local HTTP server, and provides functions to sign tokens with
// configurable claims. Used by test scripts to exercise the
// full verification pipeline without any external IDP.
//
// Usage:
//   import { createTestJWKS } from './src/auth/_test-helper.js';
//   const helper = await createTestJWKS({ port: 9876 });
//   const token = await helper.signToken({ sub: "user1" });
//   // ... test with token ...
//   await helper.close();
// ═══════════════════════════════════════════════════════════════

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import http from "node:http";
import crypto from "node:crypto";

/**
 * Create a local JWKS server and token signer for testing.
 *
 * @param {object} options
 * @param {number} options.port       — local server port (default: 0 = random)
 * @param {string} options.issuer     — token issuer claim
 * @param {string} options.audience   — token audience claim
 * @returns {Promise<object>} helper with signToken(), close(), issuer, jwksUri
 */
export async function createTestJWKS(options = {}) {
  const port = options.port || 0;
  const issuer = options.issuer || "https://test-issuer.local/";
  const audience = options.audience || "https://linkedin-agent-api";

  // Generate RSA key pair
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = crypto.randomBytes(8).toString("hex");

  // Export public key as JWK
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  const jwksResponse = JSON.stringify({ keys: [publicJwk] });

  // Start local HTTP server serving JWKS
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(jwksResponse);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const actualPort = server.address().port;
  const jwksUri = `http://127.0.0.1:${actualPort}/.well-known/jwks.json`;

  return {
    issuer,
    audience,
    jwksUri,
    port: actualPort,
    kid,

    /**
     * Sign a JWT with the test private key.
     *
     * @param {object} claims      — payload claims (sub, email, name, etc.)
     * @param {object} overrides   — override iss, aud, exp, iat
     * @returns {Promise<string>} signed JWT string
     */
    async signToken(claims = {}, overrides = {}) {
      const now = Math.floor(Date.now() / 1000);

      const jwt = new SignJWT({
        sub: claims.sub || "test_user_001",
        email: claims.email || "test@example.com",
        name: claims.name || "Test User",
        ...claims
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(overrides.issuer || issuer)
        .setAudience(overrides.audience || audience)
        .setIssuedAt(overrides.iat || now)
        .setExpirationTime(overrides.exp || now + 3600);

      return jwt.sign(privateKey);
    },

    /**
     * Sign a token that is already expired.
     */
    async signExpiredToken(claims = {}) {
      const past = Math.floor(Date.now() / 1000) - 3600;
      return this.signToken(claims, { iat: past - 3600, exp: past });
    },

    /**
     * Sign a token with a wrong issuer.
     */
    async signWrongIssuerToken(claims = {}) {
      return this.signToken(claims, { issuer: "https://evil-issuer.com/" });
    },

    /**
     * Sign a token with a wrong audience.
     */
    async signWrongAudienceToken(claims = {}) {
      return this.signToken(claims, { audience: "https://wrong-api" });
    },

    /**
     * Generate a completely fabricated token (wrong signature).
     */
    fabricateToken() {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: "fake", iss: issuer, aud: audience,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString("base64url");
      const fakeSig = crypto.randomBytes(64).toString("base64url");
      return `${header}.${payload}.${fakeSig}`;
    },

    /**
     * Shut down the local JWKS server.
     */
    async close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
