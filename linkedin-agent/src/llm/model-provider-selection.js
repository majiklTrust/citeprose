// ═══════════════════════════════════════════════════════════════
// Model Provider selection validation (4.25111.17, closes refactor
// item 8)
// ═══════════════════════════════════════════════════════════════
//
// ONE validator for every door that stores a Model Provider
// selection. Before this module existed the /app/admin card and the
// registration workflow each ran their own subset of these checks:
// the card resolved the model through the registry and registration
// did not, so a model string that the card would refuse at the form
// could still enter agent_state through registration and fail days
// later inside a scheduled run. The two doors now enforce the same
// invariant with the same code, and a third door added later starts
// correct by importing this instead of re-deriving the checks.
//
// Check order is the card's, preserved deliberately:
//   1. provider resolves in the registry        (UNKNOWN_PROVIDER)
//   2. model resolves for that provider          (UNKNOWN_MODEL)
//   3. text generation is available              (TEXT_PROVIDER_COMING_SOON)
//   4. the API key verifies with the Model Provider, only when one
//      is supplied and not exempted               (KEY_INVALID /
//                                                 KEY_VALIDATION_UNAVAILABLE)
// Steps 1 through 3 are pure registry reads; the only network call
// is step 4, so a refused selection never spends a round trip.
//
// Scope, stated honestly: "model resolves" means the registry's own
// contract, which accepts curated MODELS entries, ids listed by a
// provider's modelsEnv, and ids matching the provider's
// wireIdPattern. A plausible-but-wrong id that fits the pattern
// (for anthropic, anything starting "claude-") passes here exactly
// as it passes the card today; the run-time refusals remain the
// backstop for those. This module makes the doors EQUAL, not
// stricter than the card the operator already trusts.
//
// SECURITY: the apiKey is passed to the key validator and nothing
// else. It is never logged, never stored, and never carried on a
// thrown error.

import {
  getProvider as registryGetProvider,
  getModelProfile as registryGetModelProfile,
  textGenerationAvailability,
  textGenerationNotice,
  TEXT_GENERATION_NOTICE
} from "./registry.js";
import { validateProviderKey } from "./client.js";

// Typed refusal. `code` is the machine contract callers map to their
// own HTTP responses and log actions; `causeCode` carries the
// underlying error code on KEY_VALIDATION_UNAVAILABLE so callers can
// log what the Model Provider check actually hit.
export class ModelProviderSelectionError extends Error {
  constructor(code, message, causeCode = null) {
    super(message);
    this.name = "ModelProviderSelectionError";
    this.code = code;
    this.causeCode = causeCode;
  }
}

export function isModelProviderSelectionError(err) {
  return err instanceof ModelProviderSelectionError;
}

// Validates a Model Provider selection before anything is stored.
//
//   providerId          registry provider id, e.g. "anthropic"
//   modelId             the model the selection names
//   apiKey              optional; when present it is verified with
//                       the Model Provider unless skipKeyValidation
//   skipKeyValidation   caller-side exemption (ruling 2.4.29: custom
//                       endpoints cannot be verified from here)
//   env                 environment for registry resolution
//   validateKey         injectable per the routes' deps convention
//   getProviderFn /
//   getModelProfileFn   injectable for the same reason
//
// Returns Object.freeze({ providerEntry, profile, keyVerdict }) with
// keyVerdict "valid" or "skipped". Throws
// ModelProviderSelectionError for every refusal; anything else that
// escapes is a programming error and propagates as itself.
export async function validateModelProviderSelection({
  providerId,
  modelId,
  apiKey = null,
  skipKeyValidation = false,
  env = process.env,
  validateKey = validateProviderKey,
  getProviderFn = registryGetProvider,
  getModelProfileFn = registryGetModelProfile
} = {}) {
  let providerEntry;
  try {
    providerEntry = getProviderFn(providerId);
  } catch {
    throw new ModelProviderSelectionError(
      "UNKNOWN_PROVIDER",
      `Unknown Model Provider '${String(providerId)}'`
    );
  }

  let profile;
  try {
    profile = getModelProfileFn(
      providerEntry.id,
      typeof modelId === "string" ? modelId.trim() : "",
      env
    );
  } catch {
    throw new ModelProviderSelectionError(
      "UNKNOWN_MODEL",
      "Model is not registered for the selected Model Provider"
    );
  }

  if (textGenerationAvailability(providerEntry.id) !== "available") {
    throw new ModelProviderSelectionError(
      "TEXT_PROVIDER_COMING_SOON",
      textGenerationNotice(providerEntry.id) || TEXT_GENERATION_NOTICE
    );
  }

  let keyVerdict = "skipped";
  if (apiKey && !skipKeyValidation) {
    let verdict;
    try {
      verdict = await validateKey(providerEntry.id, apiKey);
    } catch (err) {
      throw new ModelProviderSelectionError(
        "KEY_VALIDATION_UNAVAILABLE",
        "Unable to verify the API key with the selected Model Provider",
        err && err.code ? err.code : null
      );
    }
    if (!verdict || verdict.valid !== true) {
      throw new ModelProviderSelectionError(
        "KEY_INVALID",
        "API key is not valid for the selected Model Provider"
      );
    }
    keyVerdict = "valid";
  }

  return Object.freeze({ providerEntry, profile, keyVerdict });
}
