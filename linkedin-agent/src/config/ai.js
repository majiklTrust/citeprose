// ═══════════════════════════════════════════════════════════════
// AI Configuration — Anthropic model selection
// ═══════════════════════════════════════════════════════════════
//
// Single source of truth for the Anthropic model name used by
// content generation and research services. Three-level fallback:
//
//   1. agent_state key 'anthropic_model' (per-tenant, highest)
//   2. process.env.ANTHROPIC_MODEL       (deployment-level)
//   3. DEFAULT_MODEL constant            (hardcoded floor)
//
// Must be called inside a withTenant() block so the agent_state
// lookup has tenant context for RLS. If the DB read fails (table
// empty, key missing, connection error), falls through silently
// to the next level — never throws on a missing override.

import { getAgentState } from "../services/database.js";

// Hardcoded value flagged per project convention. This default
// ensures the system always has a valid model even with zero
// configuration. To change the deployment-wide default without
// a code change, set ANTHROPIC_MODEL in .env. To override
// per-tenant, set the 'anthropic_model' key in agent_state via
// the dashboard or direct SQL.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// Hardcoded value flagged per project convention. The Anthropic
// API base URL is used in error messages when a model name is
// rejected by the API. Abstraction path: could be moved to .env
// as ANTHROPIC_API_URL if the deployment targets a proxy or
// alternative endpoint.
const ANTHROPIC_API_URL = "https://api.anthropic.com";

// Response-size caps for the AI calls made by the feed discovery
// and topic assistance surfaces, and the page size for the
// platform-admin live model listing. Env-overridable with the
// hardcoded floor as the zero-configuration default, matching
// the posts-window.js pattern: invalid or unset input always
// falls back to a sane value, never NaN.
function intFromEnv(name, fallback) {
  const n = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getFeedDiscoveryMaxTokens() {
  return intFromEnv("FEED_DISCOVERY_MAX_TOKENS", 2000);
}

export function getFeedDiscoveryRetryMaxTokens() {
  return intFromEnv("FEED_DISCOVERY_RETRY_MAX_TOKENS", 1500);
}

export function getTopicSearchTemplateMaxTokens() {
  return intFromEnv("TOPIC_SEARCH_TEMPLATE_MAX_TOKENS", 600);
}

export function getTopicSuggestionMaxTokens() {
  return intFromEnv("TOPIC_SUGGESTION_MAX_TOKENS", 1500);
}

export function getModelListingPageLimit() {
  return intFromEnv("MODEL_LISTING_PAGE_LIMIT", 100);
}

/**
 * Returns the Anthropic model string for the current tenant.
 *
 * Fallback chain: DB → env → default.
 *
 * @returns {Promise<string>} model identifier (e.g. "claude-haiku-4-5-20251001")
 */
export async function getAnthropicModel() {
  // Level 1: per-tenant DB override
  try {
    const dbValue = await getAgentState("anthropic_model");
    if (dbValue && typeof dbValue === "string" && dbValue.trim().length > 0) {
      return dbValue.trim();
    }
  } catch {
    // DB read failed — fall through silently
  }

  // Level 2: deployment-level env override
  const envValue = process.env.ANTHROPIC_MODEL;
  if (envValue && typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  // Level 3: hardcoded default
  return DEFAULT_MODEL;
}

/**
 * Wraps client.messages.create() with model-not-found detection.
 *
 * All Anthropic API calls should go through this wrapper so that
 * a bad model name produces a clear, actionable error instead of
 * a generic API failure. The call stack stops immediately — no
 * retry, no fallback to a different model.
 *
 * @param {object} client  — Anthropic SDK client instance
 * @param {object} params  — parameters for messages.create()
 * @returns {Promise<object>} the API response
 * @throws {Error} with a descriptive message if the model is rejected
 */
export async function callAnthropic(client, params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    // The Anthropic SDK surfaces HTTP errors with a status property.
    // A 404 with 'not_found_error' means the model doesn't exist.
    // A 400 that mentions 'model' in the message is also a model
    // rejection (some API versions return 400 instead of 404).
    const status = err?.status || err?.statusCode;
    const errType = err?.error?.type || "";
    const errMsg = (err?.message || "").toLowerCase();

    const isModelError =
      (status === 404 && errType === "not_found_error") ||
      (status === 404 && errMsg.includes("model")) ||
      (status === 400 && errMsg.includes("model"));

    if (isModelError) {
      const model = params.model || "(unknown)";
      throw new Error(
        `Model "${model}" does not exist at ${ANTHROPIC_API_URL}. ` +
        `Verify the model name in your workspace settings (agent_state table, key "anthropic_model").`
      );
    }

    // Strip request body from SDK errors — the Anthropic SDK may
    // attach the full request (including prompt content) to the
    // error object. Removing it prevents prompt leakage via error
    // handlers or logging further up the call stack.
    if (err.request) err.request = undefined;
    if (err.body) err.body = undefined;

    throw err;
  }
}
