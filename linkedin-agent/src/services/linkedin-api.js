// ═══════════════════════════════════════════════════════════════
// LinkedIn API Service — OAuth 2.0 & Post Publishing
// ═══════════════════════════════════════════════════════════════

import axios from "axios";
import { logActivity } from "./database.js";
import {
  getLinkedInAccessToken,
  getLinkedInPersonUrn
} from "../tenant/credential-store.js";
import { currentTenantId } from "../db/with-tenant.js";
import { platformLog } from "./platform-log.js";
import { LINKEDIN_OAUTH_SCOPES } from "../config/linkedin-scopes.js";
import {
  getTenantLinkedInClientId,
  getTenantLinkedInClientSecret,
  getTenantLinkedInRedirectUri
} from "./linkedin-app-credentials.js";

const LINKEDIN_API = "https://api.linkedin.com/v2";
const LINKEDIN_AUTH = "https://www.linkedin.com/oauth/v2";

// ── Encrypted client credentials ─────────────────────────────
// LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are stored ENCRYPTED
// at rest (AES-256-GCM under HKDF(ENCRYPTION_SECRET), via
// platform-secret.js). Each is decrypted once and cached, keyed on
// the ciphertext so a runtime env change invalidates the cache.
// A missing or undecryptable value throws — the OAuth flow fails
// closed rather than proceeding with a bad credential.

// App credential resolution (client id, client secret, redirect
// URI) lives in services/linkedin-app-credentials.js: tenant row
// first, platform env fallback (TD-1). This module only consumes
// the resolved values; it no longer reads those env vars.

// ── OAuth 2.0 Flow ───────────────────────────────────────────

export async function getAuthorizationUrl(state) {
  // Full granted scope set (13), from the single source of truth in
  // config/linkedin-scopes.js. Per FR-CC-03: request the confirmed
  // scopes, never a reduced default set.
  const scopes = LINKEDIN_OAUTH_SCOPES;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: await getTenantLinkedInClientId(),
    redirect_uri: await getTenantLinkedInRedirectUri(),
    scope: scopes.join(" "),
    state: state || generateState()
  });

platformLog("info", "get_authorization_url", {
  scope: scopes.join(" ")
});

  return `${LINKEDIN_AUTH}/authorization?${params}`;
}

export async function exchangeCodeForToken(code) {
  try {
    const response = await axios.post(
      `${LINKEDIN_AUTH}/accessToken`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: await getTenantLinkedInRedirectUri(),
        client_id: await getTenantLinkedInClientId(),
        client_secret: await getTenantLinkedInClientSecret()
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    await logActivity("info", "linkedin_token_obtained", {
      expiresIn: response.data.expires_in
    });

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
      refreshToken: response.data.refresh_token,
      // Present when the app is enabled for programmatic refresh;
      // undefined otherwise. Callers treat absence as "no refresh
      // capability" and surface it, never guess (FR-CC-03).
      refreshTokenExpiresIn: response.data.refresh_token_expires_in
    };
  } catch (err) {
    await logActivity("error", "linkedin_token_exchange_failed", {
      error: err.response?.data || err.message
    });
    throw err;
  }
}

// ── Refresh grant (FR-CC-03) ─────────────────────────────────
// Exchanges a refresh token for a new access token at the same
// OAuth endpoint, with the same encrypted client credentials.
// Pure exchange: persistence and expiry bookkeeping live in
// services/linkedin-token.js. LinkedIn may rotate the refresh
// token; when it does, the new one is returned and MUST replace
// the stored one. No token value is ever logged.
export async function refreshAccessToken(refreshToken) {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("refreshAccessToken requires a refresh token");
  }
  const response = await axios.post(
    `${LINKEDIN_AUTH}/accessToken`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: await getTenantLinkedInClientId(),
      client_secret: await getTenantLinkedInClientSecret()
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return {
    accessToken: response.data.access_token,
    expiresIn: response.data.expires_in,
    refreshToken: response.data.refresh_token,
    refreshTokenExpiresIn: response.data.refresh_token_expires_in
  };
}

// ── Profile ──────────────────────────────────────────────────

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getProfile(accessToken, retries = 2) {
  // If caller passed a token explicitly, use it (OAuth callback path).
  // Otherwise fetch the current tenant's stored token.
  const token = accessToken || await getLinkedInAccessToken();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await delay(2000 * attempt);
      const response = await axios.get(`${LINKEDIN_API}/userinfo`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries) {
        await logActivity("warn", "linkedin_profile_rate_limited", { attempt: attempt + 1, retries });
        continue;
      }
      throw err;
    }
  }
}

// ── Posting ──────────────────────────────────────────────────

export async function publishPost(content, hashtags = []) {
  let token, personUrn;
  try {
    token = await getLinkedInAccessToken();
    personUrn = await getLinkedInPersonUrn();
  } catch (err) {
    throw new Error("LinkedIn credentials not configured for this tenant. Connect via /auth/linkedin");
  }

  // Append hashtags to the post body
  const hashtagString = hashtags.length > 0 ? `\n\n${hashtags.join(" ")}` : "";
  const fullContent = `${content}${hashtagString}`;

  // ugcPosts API payload — works with "Share on LinkedIn" product (w_member_social scope)
  // Note: The newer /rest/posts endpoint requires Community Management API access
  const payload = {
    author: personUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: fullContent
        },
        shareMediaCategory: "NONE"
      }
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
    }
  };

  try {
    const response = await axios.post(`${LINKEDIN_API}/ugcPosts`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0"
      }
    });

    const postId = response.headers["x-restli-id"] || response.data?.id || null;

    if (!postId) {
      await logActivity("warn", "linkedin_post_no_id", {
        status: response.status,
        headers: JSON.stringify(response.headers)
      });
    }

    await logActivity("info", "linkedin_post_published", {
      postId,
      status: response.status,
      contentLength: fullContent.length
    });

    return { success: true, postId };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    const statusCode = err.response?.status;

    await logActivity("error", "linkedin_post_failed", {
      status: statusCode,
      error: errorDetail
    });

    if (statusCode === 401) {
      throw new Error("LinkedIn access token expired. Reconnect via /auth/linkedin");
    }
    if (statusCode === 422) {
      throw new Error(`LinkedIn rejected the post content: ${JSON.stringify(errorDetail)}`);
    }

    throw new Error(`LinkedIn API error (${statusCode}): ${JSON.stringify(errorDetail)}`);
  }
}

// ── Token Validation (per-tenant cache) ──────────────────────
// Cache is keyed by tenant UUID so tenant A's validity answer
// is never served to tenant B. Must be called inside withTenant
// so currentTenantId() returns a valid key.

const _tokenCacheByTenant = new Map();

function getTokenCacheTtl() {
  return parseInt(process.env.LINKEDIN_TOKEN_CHECK_MINUTES || "10", 10) * 60 * 1000;
}

function getCacheEntry(tenantId) {
  return _tokenCacheByTenant.get(tenantId) || null;
}

function setCacheEntry(tenantId, value) {
  _tokenCacheByTenant.set(tenantId, { value, ts: Date.now() });
}

// Clear a tenant's cached token validation result. Called after
// the LinkedIn OAuth callback stores new credentials — without
// this, the dashboard reads a stale { valid: false } from the
// cache until the TTL expires (default 10 minutes).
export function invalidateTokenCache(tenantId) {
  _tokenCacheByTenant.delete(tenantId);
}

export async function validateToken() {
  const tenantId = currentTenantId();
  if (!tenantId) {
    // Called outside tenant context — cannot resolve credentials
    return { valid: false, reason: "No tenant context" };
  }

  // Return cached result if fresh
  const cached = getCacheEntry(tenantId);
  if (cached && (Date.now() - cached.ts) < getTokenCacheTtl()) {
    return cached.value;
  }

  try {
    const profile = await getProfile();
    const result = { valid: true, name: profile.name, sub: profile.sub };
    setCacheEntry(tenantId, result);
    return result;
  } catch (err) {
    let result;
    if (err.response?.status === 401) {
      result = { valid: false, reason: "Token expired or invalid" };
    } else if (err.response?.status === 429) {
      // Rate limited — keep previous cache entry if we have one
      if (cached) {
        setCacheEntry(tenantId, cached.value);
        return cached.value;
      }
      result = { valid: true, reason: "Token status unknown (rate limited)" };
    } else {
      result = { valid: false, reason: err.message };
    }
    setCacheEntry(tenantId, result);
    return result;
  }
}

// Clear cache on new auth (called after successful OAuth).
// Clears only the current tenant's entry, not the whole cache.
export function clearTokenCache() {
  const tenantId = currentTenantId();
  if (tenantId) {
    _tokenCacheByTenant.delete(tenantId);
  }
}

// ── Utilities ────────────────────────────────────────────────

function generateState() {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}