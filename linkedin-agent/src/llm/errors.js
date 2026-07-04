// ═══════════════════════════════════════════════════════════════
// src/llm/errors.js - typed error taxonomy for the LLM abstraction
// ═══════════════════════════════════════════════════════════════
// Every failure inside src/llm surfaces as an LlmError with a code
// from LLM_ERROR_CODES. Callers branch on codes, never on message
// text. Fail-closed paths (unknown provider or model, missing key,
// off-allowlist host) each have a dedicated code so tests and
// operators can tell a policy denial from a vendor outage.
//
// Leaf module: no imports. Nothing here may pull in vendor SDKs,
// network code, or logging.
// ═══════════════════════════════════════════════════════════════

export const LLM_ERROR_CODES = Object.freeze({
  UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
  UNKNOWN_MODEL: "UNKNOWN_MODEL",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  NOT_PROVISIONED: "NOT_PROVISIONED",
  MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
  INVALID_REQUEST: "INVALID_REQUEST",
  EGRESS_BLOCKED: "EGRESS_BLOCKED",
  TIMEOUT: "TIMEOUT",
  VENDOR_HTTP: "VENDOR_HTTP",
  BAD_RESPONSE: "BAD_RESPONSE"
});

const KNOWN_CODES = new Set(Object.values(LLM_ERROR_CODES));

export class LlmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LlmError";
    this.code = KNOWN_CODES.has(code) ? code : LLM_ERROR_CODES.BAD_RESPONSE;
    // details must stay log-safe: constructors only put identifiers
    // and counts here, never prompt content, keys, or headers.
    this.details = details && typeof details === "object" ? details : {};
  }
}

export function llmError(code, message, details) {
  return new LlmError(code, message, details);
}

export function isLlmError(err) {
  return err instanceof LlmError;
}

// Body snippets from vendors are truncated hard so an error path
// can never become a data exfiltration channel through logs.
const BODY_SNIPPET_MAX = 200;

export function normalizeVendorHttpError(providerId, httpStatus, bodyText) {
  const status = Number.isInteger(httpStatus) ? httpStatus : 0;
  const snippet = typeof bodyText === "string"
    ? bodyText.slice(0, BODY_SNIPPET_MAX)
    : "";
  return new LlmError(
    LLM_ERROR_CODES.VENDOR_HTTP,
    `LLM provider ${String(providerId)} returned HTTP ${status}`,
    { providerId: String(providerId), status, bodySnippet: snippet }
  );
}
