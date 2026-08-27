// ═══════════════════════════════════════════════════════════════
// Provider error classification (4.25111.38, corrected 4.25111.41,
// message discipline 4.25111.42)
// ═══════════════════════════════════════════════════════════════
//
// One classifier for every Model Provider failure, whichever wire it
// arrived on: the Anthropic SDK path (research), the orchestrator
// (generation, quality, refine), or raw axios/fetch transport
// errors. Born from a day the tenant key was denied for insufficient
// funds and the application reported "insufficient sources" and
// "An internal error occurred" while the truth sat in one log blob:
// a provider failure must be recognized ONCE, named in operator
// language, and carried wherever the failure surfaces (the blocked
// reason, the HTTP response, the activity trail, the spend ledger).
//
// MESSAGE DISCIPLINE (4.25111.42): the module does not paraphrase
// the provider. When the provider's own message could be extracted,
// the operator line is a neutral lead plus the provider's words,
// named by provider:
//
//   The backend LLM request failed. Anthropic said: "You have
//   reached your specified API usage limits. ..."
//
// The class-specific sentences the module used to lead with
// asserted account states (insufficient funds, configured limits,
// revoked keys, a web search tool) that this code cannot actually
// know beyond the provider's text, and repeating them next to the
// quote said everything twice. They survive only as factual
// fallbacks for errors that carry no provider words (bare statuses,
// transport failures), stating provider, condition, and HTTP status
// and nothing more.
//
// classifyProviderError(err, opts) returns null when the error
// shows no evidence of a provider interaction (no HTTP status, no
// provider error body, no transport code): such errors are the
// application's own and keep their existing handling. opts.providerId
// lets a call site that KNOWS its provider (the research SDK path
// is always Anthropic) name it when the error object cannot.
// Otherwise it returns:
//
//   {
//     class:           billing | usage_limit | auth | rate_limit |
//                      model_invalid | tool_invalid | timeout |
//                      network | provider_error
//     retriable:       whether retrying later can succeed without an
//                      operator acting first
//     operatorMessage: the alert line (discipline above)
//     providerMessage: the provider's own message, alone; null when
//                      none could be extracted
//     requestId:       the provider's request id when the body
//                      carries one (support tickets); null otherwise
//     providerId:      lowercase provider id when known; null
//     status:          HTTP status when known; null
//   }
//
// providerFailureLogDetails(err, pf) builds the COMPLETE error
// record for the activity log and platform log: raw message, class,
// retriable, status, provider, request id, provider words, body
// snippet, transport code. One shape at every failure site, so no
// log ever again carries less than the whole truth (4.25111.42).
//
// Detection reads only SHAPES, never provider prose beyond the few
// stable substrings the vendor documents (credit balance, api key,
// usage limits), so a copy change cannot silently reclassify errors
// into the generic bucket: status codes and typed error bodies
// decide first.
// ═══════════════════════════════════════════════════════════════

// usage_limit is NOT retriable: access returns only at the
// provider's stated reset time (carried in providerMessage), which
// is hours or days away; pacing logic must not spin on it, and an
// operator can raise the limit instead of waiting.
const RETRIABLE = Object.freeze(new Set(["rate_limit", "timeout", "network", "provider_error"]));

// Factual fallback details, used ONLY when no provider message was
// extracted. Each states what the wire showed: provider, condition,
// status. No account diagnosis, no guessed tool names.
const FALLBACKS = Object.freeze({
  billing: (name, st) => `${name} declined the call over billing${st}.`,
  usage_limit: (name, st) => `${name} reported an API usage limit has been reached${st}.`,
  auth: (name, st) => `${name} refused the request as unauthorized${st}.`,
  rate_limit: (name, st) => `${name} is rate limiting or overloaded${st}; the call can be retried shortly.`,
  model_invalid: (name, st) => `${name} does not recognize the requested model${st}.`,
  tool_invalid: (name, st) => `${name} rejected the request's tool configuration${st}.`,
  timeout: (name) => `The call to ${name} timed out before completing.`,
  network: (name) => `${name} could not be reached (network failure).`,
  provider_error: (name, st) => `${name} returned an internal error${st}.`,
  // Used in place of the provider_error text for a 4xx that matched
  // no known shape: a rejection is not an internal error, and saying
  // so misdirected the operator (4.25111.41).
  provider_rejected: (name, st) => `${name} rejected the request${st}.`
});

const LEAD = "The backend LLM request failed.";

// ── Extraction helpers ──────────────────────────────────────────

// The provider-typed error body appears in different nests per wire:
// the SDK sets err.error (already parsed or a raw JSON string in
// err.message), axios sets err.response.data, and the orchestrator's
// LlmError keeps only details.bodySnippet. Probe the structured
// spots, then scan the assembled text. 4.25111.41: the text scan
// must consider EVERY "type" occurrence, not the first. The vendor
// envelope is {"type":"error","error":{"type":"<real type>",...}},
// so a first-match regex always found the outer "error", the
// !== "error" guard discarded it, and the real nested type was never
// reached: every message-embedded typed body classified as if it
// had no type at all.
function extractType(err, text) {
  const candidates = [
    err && err.error && err.error.error && err.error.error.type,
    err && err.error && err.error.type,
    err && err.response && err.response.data && err.response.data.error && err.response.data.error.type
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  for (const m of text.matchAll(/"type"\s*:\s*"([a-z_]+)"/g)) {
    if (m[1] !== "error") return m[1];
  }
  return "";
}

// The provider's own message: the one string worth showing a human
// verbatim (it names amounts, dates, fields, models). Structured
// spots first, then the first JSON "message" string in the text
// (the envelope has no message of its own; the nested error does).
// The body snippet is truncated upstream, so the regex must accept
// escaped characters but never require a well-formed document.
function extractProviderMessage(err, text) {
  const candidates = [
    err && err.error && err.error.error && err.error.error.message,
    err && err.error && err.error.message,
    err && err.response && err.response.data && err.response.data.error && err.response.data.error.message
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c && c !== err.message) return capLen(c);
  }
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  return m && m[1] ? capLen(unescapeJsonString(m[1])) : null;
}

// Support-ticket handle. The snippet is often cut mid-id, so no
// closing quote is required; a prefix of the id still finds the
// request in the provider console.
function extractRequestId(text) {
  const m = /"request_id"\s*:\s*"([A-Za-z0-9_-]+)/.exec(text);
  return m ? m[1] : null;
}

function unescapeJsonString(s) {
  return s.replace(/\\(["\\/]|[bfnrt]|u[0-9a-fA-F]{4})/g, (whole, esc) => {
    if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc === '"' || esc === "\\" || esc === "/") return esc;
    return " ";
  });
}

function capLen(s) {
  const t = String(s).trim();
  return t.length > 300 ? t.slice(0, 297) + "..." : t;
}

function extractStatus(err) {
  return Number(
    (err.status !== undefined ? err.status : undefined)
    ?? err.statusCode
    ?? (err.response && err.response.status)
    ?? (err.details && err.details.status)
  ) || null;
}

// Display name: lowercase provider id, capitalized. No registry
// import (this module must stay dependency-free and synchronous);
// an id the wire never named falls back to the generic noun.
function displayName(providerId) {
  if (typeof providerId === "string" && providerId) {
    return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }
  return "The Model Provider";
}

export function classifyProviderError(err, opts = {}) {
  if (!err) return null;
  const status = extractStatus(err);
  const code = String(err.code || "");
  const name = String(err.name || "");
  const providerId = (err.details && err.details.providerId) || opts.providerId || null;
  // The orchestrator normalizes vendor HTTP failures into LlmError
  // with {status, bodySnippet} in details; the snippet is where the
  // vendor's own words (credit balance, usage limits, invalid key)
  // survive.
  const text = [
    err.message,
    err.error ? safeString(err.error) : "",
    err.response && err.response.data ? safeString(err.response.data) : "",
    err.details && err.details.bodySnippet ? String(err.details.bodySnippet) : ""
  ].filter(Boolean).join(" ").slice(0, 4000);
  const type = extractType(err, text);
  const providerMessage = extractProviderMessage(err, text);
  const requestId = extractRequestId(text);

  const result = (cls, fallbackKey) => {
    const who = displayName(providerId);
    const st = status ? ` (HTTP ${status})` : "";
    const operatorMessage = providerMessage
      ? `${LEAD} ${who} said: "${providerMessage}"`
      : `${LEAD} ${FALLBACKS[fallbackKey || cls](who, st)}`;
    return {
      class: cls,
      retriable: RETRIABLE.has(cls),
      operatorMessage,
      providerMessage: providerMessage || null,
      requestId: requestId || null,
      providerId: providerId || null,
      status
    };
  };

  // Transport-level failures carry no status at all.
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EPIPE/.test(code)
    || /fetch failed|socket hang up|network error/i.test(text)) {
    return result("network");
  }
  if (/ETIMEDOUT|ABORT/i.test(code) || /Abort|Timeout/i.test(name) || /timed? ?out/i.test(text)) {
    return result("timeout");
  }

  // No status and no provider-typed body: not a provider failure.
  if (!status && !type) return null;

  // Billing and usage limits before the generic 400 bucket: the
  // vendor ships both as invalid_request_error, so the documented
  // substrings are the only separators between "you misconfigured",
  // "you must pay", and "your own cap is met" (4.25111.41 added the
  // cap: "You have reached your specified API usage limits. You
  // will regain access on <date>", where the date the operator
  // needs rides in providerMessage).
  if (/credit balance|billing|insufficient funds|purchase credits/i.test(text)) {
    return result("billing");
  }
  if (/usage limits?|spend(ing)? limit|monthly limit/i.test(text)) {
    return result("usage_limit");
  }
  if (status === 401 || type === "authentication_error" || /invalid x-api-key|api key/i.test(text) && status === 403) {
    return result("auth");
  }
  if (status === 429 || status === 529 || type === "rate_limit_error" || type === "overloaded_error") {
    return result("rate_limit");
  }
  if (type === "not_found_error" || (status === 404 && /model/i.test(text))) {
    return result("model_invalid");
  }
  // The same field-path convention config/ai.js uses: a rejected
  // request names the offending path ("tools.0.type").
  if (/(^|[^a-z_])tools(\.[a-z0-9_]+)*\s*[:.]/i.test(text)) {
    return result("tool_invalid");
  }
  if (status >= 500) return result("provider_error");
  // A 4xx that matched nothing above: an unknown REJECTION. Class
  // stays provider_error (the ledger vocabulary is stable) but the
  // operator line says rejected, not internal, and carries the
  // provider's message so an unrecognized denial still explains
  // itself (4.25111.41). A rejection re-sent unchanged is rejected
  // again, so unlike the 5xx case above it is NOT retriable.
  if (status) {
    const r = result("provider_error", "provider_rejected");
    r.retriable = false;
    return r;
  }
  return null;
}

// The COMPLETE error for the books (4.25111.42): every failure site
// that writes the activity log or platform log spreads this in, so
// the record carries the raw message, the classification, the wire
// facts (status, provider, request id, body snippet, transport
// code), and the provider's own words. Pass the pf you already
// computed to avoid classifying twice; omit it to classify here.
export function providerFailureLogDetails(err, pf) {
  const p = pf === undefined ? classifyProviderError(err) : pf;
  const d = (err && err.details) || {};
  const out = {
    error: err && err.message ? String(err.message) : String(err),
    errorClass: p ? p.class : "unclassified"
  };
  if (p) {
    out.retriable = p.retriable;
    out.operatorMessage = p.operatorMessage;
    if (p.providerMessage) out.providerMessage = p.providerMessage;
    if (p.requestId) out.requestId = p.requestId;
  }
  const status = err ? extractStatus(err) : null;
  if (status) out.status = status;
  const providerId = d.providerId || (p && p.providerId) || null;
  if (providerId) out.providerId = providerId;
  if (d.bodySnippet) out.bodySnippet = String(d.bodySnippet);
  if (err && err.code) out.code = String(err.code);
  if (err && err.name && err.name !== "Error") out.errorName = String(err.name);
  return out;
}

function safeString(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
