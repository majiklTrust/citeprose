// ═══════════════════════════════════════════════════════════════
// LinkedIn API Service — OAuth 2.0 & Post Publishing
// ═══════════════════════════════════════════════════════════════

import axios from "axios";
import { logActivity } from "./database.js";

const LINKEDIN_API = "https://api.linkedin.com/v2";
const LINKEDIN_AUTH = "https://www.linkedin.com/oauth/v2";

// ── OAuth 2.0 Flow ───────────────────────────────────────────

export function getAuthorizationUrl() {
  const scopes = ["openid", "profile", "w_member_social"];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    scope: scopes.join(" "),
    state: generateState()
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

    logActivity("info", "linkedin_token_obtained", {
      expiresIn: response.data.expires_in
    });

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
      refreshToken: response.data.refresh_token
    };
  } catch (err) {
    logActivity("error", "linkedin_token_exchange_failed", {
      error: err.response?.data || err.message
    });
    throw err;
  }
}

// ── Profile ──────────────────────────────────────────────────

export async function getProfile(accessToken) {
  const token = accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
  const response = await axios.get(`${LINKEDIN_API}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.data;
}

// ── Posting ──────────────────────────────────────────────────

export async function publishPost(content, hashtags = []) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const personUrn = process.env.LINKEDIN_PERSON_URN;

  if (!token || !personUrn) {
    throw new Error("LinkedIn credentials not configured. Run: npm run auth");
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
      logActivity("warn", "linkedin_post_no_id", {
        status: response.status,
        headers: JSON.stringify(response.headers)
      });
    }

    logActivity("info", "linkedin_post_published", {
      postId,
      status: response.status,
      contentLength: fullContent.length
    });

    return { success: true, postId };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    const statusCode = err.response?.status;

    logActivity("error", "linkedin_post_failed", {
      status: statusCode,
      error: errorDetail
    });

    if (statusCode === 401) {
      throw new Error("LinkedIn access token expired. Run: npm run auth");
    }
    if (statusCode === 422) {
      throw new Error(`LinkedIn rejected the post content: ${JSON.stringify(errorDetail)}`);
    }

    throw new Error(`LinkedIn API error (${statusCode}): ${JSON.stringify(errorDetail)}`);
  }
}

// ── Token Validation ─────────────────────────────────────────

export async function validateToken() {
  try {
    const profile = await getProfile();
    return { valid: true, name: profile.name, sub: profile.sub };
  } catch (err) {
    if (err.response?.status === 401) {
      return { valid: false, reason: "Token expired or invalid" };
    }
    return { valid: false, reason: err.message };
  }
}

// ── Utilities ────────────────────────────────────────────────

function generateState() {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}