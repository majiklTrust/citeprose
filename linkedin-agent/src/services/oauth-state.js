// =================================================================
// src/services/oauth-state.js, signed member OAuth state (pure)
// =================================================================
// The member OAuth leg shares the single registered redirect URI
// with the tenant leg; the callback dispatches on the state. The
// member state is therefore a SIGNED payload: m1.<b64url(json)>.
// <b64url(hmac)>, HMAC-SHA256 under an HKDF key derived from
// ENCRYPTION_SECRET with its own domain separation. The payload
// carries { p: "member", sub, tenant, n } where n is a nonce
// issued by the existing generateOAuthState machinery, so the
// existing replay protection applies unchanged; iat bounds age.
//
// Pure module: zero imports beyond node crypto, fully testable
// with an injected secret and clock.
// =================================================================

import crypto from "node:crypto";

const PREFIX = "m1.";
const HKDF_SALT = "oauth-member-state-v1";
const HKDF_INFO = "sign";
const DEFAULT_TTL_SECONDS = 600;

function signingKey(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("oauth-state requires a signing secret");
  }
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    32
  ));
}

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function isMemberState(state) {
  return typeof state === "string" && state.startsWith(PREFIX);
}

// payload: { sub, tenant, n } (purpose is stamped here, never
// caller-supplied). Returns the compact state string.
export function signMemberState(payload, deps = {}) {
  const secret = deps.secret !== undefined ? deps.secret : process.env.ENCRYPTION_SECRET;
  const nowSeconds = Number.isFinite(deps.nowSeconds) ? deps.nowSeconds : Math.floor(Date.now() / 1000);
  if (!payload || typeof payload.sub !== "string" || payload.sub.length === 0
      || typeof payload.tenant !== "string" || payload.tenant.length === 0
      || typeof payload.n !== "string" || payload.n.length === 0) {
    throw new Error("member state requires sub, tenant, and nonce");
  }
  const body = JSON.stringify({ p: "member", sub: payload.sub, tenant: payload.tenant, n: payload.n, iat: nowSeconds });
  const key = signingKey(secret);
  const mac = crypto.createHmac("sha256", key).update(body, "utf8").digest();
  return PREFIX + b64u(Buffer.from(body, "utf8")) + "." + b64u(mac);
}

// Returns { ok: true, payload } or { ok: false, reason }. Never
// throws on hostile input. Constant-time signature comparison.
export function verifyMemberState(state, deps = {}) {
  const secret = deps.secret !== undefined ? deps.secret : process.env.ENCRYPTION_SECRET;
  const nowSeconds = Number.isFinite(deps.nowSeconds) ? deps.nowSeconds : Math.floor(Date.now() / 1000);
  const ttlSeconds = Number.isFinite(deps.ttlSeconds) ? deps.ttlSeconds : DEFAULT_TTL_SECONDS;

  if (!isMemberState(state)) return { ok: false, reason: "not_member_state" };
  const parts = state.slice(PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  let bodyBuf, macBuf, key;
  try {
    bodyBuf = Buffer.from(parts[0], "base64url");
    macBuf = Buffer.from(parts[1], "base64url");
    key = signingKey(secret);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = crypto.createHmac("sha256", key).update(bodyBuf).digest();
  if (macBuf.length !== expected.length || !crypto.timingSafeEqual(macBuf, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || payload.p !== "member") return { ok: false, reason: "wrong_purpose" };
  if (typeof payload.sub !== "string" || typeof payload.tenant !== "string" || typeof payload.n !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(payload.iat) || payload.iat > nowSeconds + 60 || nowSeconds - payload.iat > ttlSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
