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

const LINKEDIN_API = "https://api.linkedin.com/v2";
const LINKEDIN_AUTH = "https://www.linkedin.com/oauth/v2";

// ── OAuth 2.0 Flow ───────────────────────────────────────────

export function getAuthorizationUrl(state) {
  const scopes = ["openid", "profile", "w_member_social"];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    scope: scopes.join(" "),
    state: state || generateState()
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
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    await logActivity("info", "linkedin_token_obtained", {
      expiresIn: response.data.expires_in
    });

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
      refreshToken: response.data.refresh_token
    };
  } catch (err) {
    await logActivity("error", "linkedin_token_exchange_failed", {
      error: err.response?.data || err.message
    });
    throw err;
  }
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