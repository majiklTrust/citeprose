// ═══════════════════════════════════════════════════════════════
// src/image/errors.js - typed error taxonomy for the image seam
// ═══════════════════════════════════════════════════════════════
// Every failure inside src/image surfaces as an ImageError with a
// code from IMAGE_ERROR_CODES. Callers branch on codes, never on
// message text. Fail-closed paths (unknown provider or model,
// unsupported size or quality, missing key, missing budget gate)
// each have a dedicated code so tests and operators can tell a
// policy denial from a vendor outage.
//
// The shared egress gate (assertHostAllowed in ../llm/security.js)
// throws with code EGRESS_BLOCKED; this taxonomy carries the same
// string so callers branch uniformly on err.code regardless of
// which kernel raised it.
//
// Leaf module: no imports. Nothing here may pull in vendor SDKs,
// network code, or logging.
// ═══════════════════════════════════════════════════════════════

export const IMAGE_ERROR_CODES = Object.freeze({
  UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
  UNKNOWN_MODEL: "UNKNOWN_MODEL",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  NOT_PROVISIONED: "NOT_PROVISIONED",
  MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNSUPPORTED_SIZE: "UNSUPPORTED_SIZE",
  UNSUPPORTED_QUALITY: "UNSUPPORTED_QUALITY",
  BUDGET_REQUIRED: "BUDGET_REQUIRED",
  BUDGET_NOT_SET: "BUDGET_NOT_SET",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  EGRESS_BLOCKED: "EGRESS_BLOCKED",
  TIMEOUT: "TIMEOUT",
  VENDOR_HTTP: "VENDOR_HTTP",
  BAD_RESPONSE: "BAD_RESPONSE",
  CONTENT_REJECTED: "CONTENT_REJECTED",
  POST_NOT_FOUND: "POST_NOT_FOUND",
  UNKNOWN_LENS: "UNKNOWN_LENS",
  UNSUPPORTED_ASPECT: "UNSUPPORTED_ASPECT",
  PRICING_UNAVAILABLE: "PRICING_UNAVAILABLE"
});

const KNOWN_CODES = new Set(Object.values(IMAGE_ERROR_CODES));

export class ImageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ImageError";
    this.code = KNOWN_CODES.has(code) ? code : IMAGE_ERROR_CODES.BAD_RESPONSE;
    // details must stay log-safe: constructors only put identifiers
    // and counts here, never prompt content, keys, or headers.
    this.details = details && typeof details === "object" ? details : {};
  }
}

export function imageError(code, message, details) {
  return new ImageError(code, message, details);
}

export function isImageError(err) {
  return err instanceof ImageError;
}

// Body snippets from vendors are truncated hard so an error path
// can never become a data exfiltration channel through logs.
const BODY_SNIPPET_MAX = 200;

export function normalizeVendorHttpError(providerId, httpStatus, bodyText) {
  const status = Number.isInteger(httpStatus) ? httpStatus : 0;
  const snippet = typeof bodyText === "string" ? bodyText.slice(0, BODY_SNIPPET_MAX) : "";
  // Diagnosability (2.5.30, the 2.5.28 lesson generalized): vendors
  // answer 4xx with a body that NAMES the cause (unverified
  // organization, quota, a rejected parameter). Extract that reason
  // and put it in the message a person actually sees; a bare
  // "HTTP 400" hides the vendor's own explanation. Sanitized: JSON
  // error.message preferred, single line, hard length cap, and never
  // any request content of ours.
  let providerMessage = "";
  try {
    const parsed = JSON.parse(snippet);
    const m = parsed && parsed.error && typeof parsed.error.message === "string" ? parsed.error.message
      : (typeof parsed.message === "string" ? parsed.message : "");
    providerMessage = m;
  } catch { providerMessage = snippet; }
  providerMessage = String(providerMessage || "").replace(/\s+/g, " ").trim().slice(0, 240);
  // A 400 whose body names a moderation or safety rejection is a
  // content denial, not a transport fault: give it its own code so
  // the UX can say "revise the prompt" rather than "try again".
  const lc = snippet.toLowerCase();
  if (status === 400 && (lc.includes("moderation") || lc.includes("safety") || lc.includes("content_policy"))) {
    return new ImageError(IMAGE_ERROR_CODES.CONTENT_REJECTED,
      `Image provider ${String(providerId)} rejected the prompt on content grounds`,
      { providerId: String(providerId), status, providerMessage });
  }
  return new ImageError(IMAGE_ERROR_CODES.VENDOR_HTTP,
    `Image provider ${String(providerId)} returned HTTP ${status}` + (providerMessage ? `: ${providerMessage}` : ""),
    { providerId: String(providerId), status, bodySnippet: snippet, providerMessage });
}
