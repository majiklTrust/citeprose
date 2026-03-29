// ═══════════════════════════════════════════════════════════════
// Server Address Utility
// ═══════════════════════════════════════════════════════════════
//
// Single source of truth for the application's external-facing
// address. Replaces all hardcoded localhost references.
//
// Resolution priority:
//   1. APP_BASE_URL env var (explicit config — always wins)
//   2. Runtime detection from server.address() after app.listen()
//   3. Fallback: http://localhost:${DASHBOARD_PORT || 3001}
//
// Usage:
//   import { setBoundAddress, getServerAddress } from "./services/server-address.js";
//   const server = app.listen(PORT, () => {
//     setBoundAddress(server.address());
//     const addr = getServerAddress();
//     // addr.origin  = "https://agent.example.com"
//     // addr.host    = "agent.example.com"
//     // addr.port    = 443
//     // addr.display = "agent.example.com"
//   });
// ═══════════════════════════════════════════════════════════════

import os from "os";

// ── State ────────────────────────────────────────────────────
// Set once after app.listen() completes. Immutable after that.
let _boundAddress = null;

/**
 * Store the result of server.address() after app.listen().
 * Must be called exactly once during startup.
 *
 * @param {{ address: string, port: number }} addr
 */
export function setBoundAddress(addr) {
  _boundAddress = addr;
}

/**
 * Resolve the server's address for external use.
 *
 * Returns an object with host, port, protocol, origin, and
 * display string. All URL-generating code should call this
 * instead of constructing URLs from hardcoded values.
 *
 * @returns {{
 *   host: string,
 *   port: number,
 *   proto: string,
 *   origin: string,
 *   display: string
 * }}
 */
export function getServerAddress() {
  const fallbackPort = parseInt(process.env.DASHBOARD_PORT || "3001", 10);

  // ── Path 1: APP_BASE_URL is set (production / explicit config) ──
  const baseUrl = process.env.APP_BASE_URL;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const proto = parsed.protocol.replace(":", "");
      const host = parsed.hostname;
      const explicitPort = parsed.port
        ? parseInt(parsed.port, 10)
        : (proto === "https" ? 443 : 80);
      const isStandardPort =
        (proto === "https" && explicitPort === 443) ||
        (proto === "http" && explicitPort === 80);

      return {
        host,
        port: explicitPort,
        proto,
        origin: `${proto}://${host}${isStandardPort ? "" : ":" + explicitPort}`,
        display: `${host}${isStandardPort ? "" : ":" + explicitPort}`
      };
    } catch {
      // APP_BASE_URL is malformed — fall through to runtime detection
    }
  }

  // ── Path 2: Runtime detection from server.address() ──
  const boundPort = _boundAddress?.port || fallbackPort;
  const rawAddr = _boundAddress?.address;

  // server.address() returns '::' or '0.0.0.0' when bound to all interfaces.
  // Neither is a usable hostname. Fall back to os.hostname(), then localhost.
  let host;
  if (rawAddr && rawAddr !== "::" && rawAddr !== "0.0.0.0" && rawAddr !== "127.0.0.1") {
    host = rawAddr;
  } else {
    // os.hostname() returns the machine name (e.g., "brandons-mac", "ip-10-0-1-47").
    // For local development this is fine. For production, APP_BASE_URL should be set.
    host = "localhost";
  }

  const proto = "http"; // Runtime detection is local dev — always HTTP

  return {
    host,
    port: boundPort,
    proto,
    origin: `${proto}://${host}:${boundPort}`,
    display: `${host}:${boundPort}`
  };
}

/**
 * Derive a full URL path from the server address.
 * Convenience wrapper for OAuth callbacks, logout URIs, etc.
 *
 * @param {string} path - e.g., "/auth/callback"
 * @returns {string} - e.g., "https://agent.example.com/auth/callback"
 */
export function getServerUrl(path) {
  const addr = getServerAddress();
  return addr.origin + (path.startsWith("/") ? path : "/" + path);
}
