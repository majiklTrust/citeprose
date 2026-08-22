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
const DEFAULT_MODEL = "not set";

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

// ── Models ───────────────────────────────────────────────────
// Per model wire facts, found by id. Each row carries the web search
// tool this deployment sends for that model: the version and its
// allowed_callers together, because the pair is constrained.
//
// Every published web_search version works on every model here. The
// constraint runs one way only: web_search_20260209 and later default
// allowed_callers to ["code_execution_20260120"], and per Anthropic's
// documentation a model that cannot call tools from inside code
// execution is then refused with a 400. Those rows pin ["direct"].
// Rows for models that can are left unpinned.
//
// A model with no row here is NOT a model that cannot search. It is a
// model this table has not been configured for. Absence is a
// configuration fact, not a capability one, and the caller refuses
// rather than guessing a tool on its behalf.
export const MODELS = Object.freeze([
  Object.freeze({
    provider: "anthropic",
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    pricing: Object.freeze({ inputPerMTokUsd: 1, outputPerMTokUsd: 5 }),
    tool: Object.freeze({
      type: "web_search_20260318",
      name: "web_search",
      allowed_callers: Object.freeze(["direct"])
    })
  }),
  Object.freeze({
    provider: "anthropic",
    id: "claude-sonnet-4-5-20250929",
    label: "Claude Sonnet 4.5",
    pricing: Object.freeze({ inputPerMTokUsd: 3, outputPerMTokUsd: 15 }),
    tool: Object.freeze({
      type: "web_search_20260318",
      name: "web_search",
      allowed_callers: Object.freeze(["direct"])
    })
  }),
  Object.freeze({
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    pricing: Object.freeze({ inputPerMTokUsd: 3, outputPerMTokUsd: 15 }),
    tool: Object.freeze({
      type: "web_search_20260318",
      name: "web_search"
    })
  }),
  Object.freeze({
    provider: "anthropic",
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    pricing: Object.freeze({ inputPerMTokUsd: 2, outputPerMTokUsd: 10 }),
    tool: Object.freeze({
      type: "web_search_20260318",
      name: "web_search"
    })
  }),
  Object.freeze({
    provider: "anthropic",
    id: "claude-opus-4-5-20251101",
    label: "Claude Opus 4.5",
    pricing: Object.freeze({ inputPerMTokUsd: 5, outputPerMTokUsd: 25 }),
    tool: Object.freeze({
      type: "web_search_20260318",
      name: "web_search",
      allowed_callers: Object.freeze(["direct"])
    })
  }),
  Object.freeze({
    provider: "anthropic",
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    pricing: Object.freeze({ inputPerMTokUsd: 5, outputPerMTokUsd: 25 }),
    tool: Object.freeze({
      type: "web_search_20260318",
      name: "web_search"
    })
  }),
  Object.freeze({
    provider: "openai",
    id: "gpt-4o",
    label: "GPT-4o"
  }),
  Object.freeze({
    provider: "openai",
    id: "gpt-4o-mini",
    label: "GPT-4o mini"
  }),
  Object.freeze({
    provider: "openai",
    id: "gpt-5",
    label: "GPT-5",
    profile: Object.freeze({
      // Reasoning family: fixed sampling temperature; the adapter
      // drops temperature instead of sending a rejected parameter.
      supportsTemperature: false,
      reasoningEffort: "medium"
    })
  }),
  Object.freeze({
    provider: "grok",
    id: "grok-3",
    label: "Grok 3"
  }),
  Object.freeze({
    provider: "grok",
    id: "grok-4",
    label: "Grok 4",
    profile: Object.freeze({
      // xAI reasoning models accept but do not honor stop sequences.
      silentlyIgnored: Object.freeze(["stopSequences"])
    })
  })
]);


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
    // KNOWN CONFLATION (audit 2.4.27): a real DB failure and the
    // routine no-tenant-context case fall through to env identically,
    // so a DB outage silently serves the deployment default model.
    // Routine frequency forbids logging here.
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
    //
    // WHICH FIELD did the vendor reject? A rejected request names the
    // offending path, "tools.0.type" or "model". The old test was
    // `status === 400 && message includes "model"`, which claimed ANY
    // 400 mentioning the word. An unusable web_search tool version
    // returns exactly that, so a tool problem was reported as a
    // non-existent model, sending the operator to agent_state to fix
    // a model that was working perfectly well on every other call.
    const status = err?.status || err?.statusCode;
    const errType = err?.error?.type || "";
    const errMsg = (err?.message || "").toLowerCase();
    const modelValue = String(params.model || "").toLowerCase();

    // Matches a JSON field path at a word boundary: "tools.0.type",
    // "model:", but not "modelling" or a model id embedded in prose.
    const namesField = (field) =>
      new RegExp("(^|[^a-z_])" + field + "(\\.[a-z0-9_]+)*\\s*[:.]").test(errMsg);

    const blamesTools = namesField("tools");
    const blamesModel = !blamesTools
      && (namesField("model") || (modelValue.length > 0 && errMsg.includes(modelValue)));

    if (blamesTools) {
      // Name the tool types actually sent. Without them the operator
      // cannot tell which value the vendor refused.
      const sent = Array.isArray(params.tools)
        ? params.tools.map((t) => t && t.type).filter(Boolean).join(", ")
        : "(none)";
      throw new Error(
        `The vendor rejected a tool in this request. Tool types sent: ${sent}. ` +
        `The tool is chosen by the selected model in ` +
        `config/ai.js MODELS; check that row. ` +
        `Vendor said: ${err?.message || "(no detail)"}`
      );
    }

    if (blamesModel && (status === 404 || status === 400 || errType === "not_found_error")) {
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
