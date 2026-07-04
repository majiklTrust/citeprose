// ═══════════════════════════════════════════════════════════════
// src/llm/security.js - egress allowlist enforcement and redaction
// ═══════════════════════════════════════════════════════════════
// Zero Trust helpers shared by the orchestrator and key validator.
//
//   assertHostAllowed(url, allowedHosts)
//     Gate run BEFORE any network call. The allowlist derives from
//     the registry's resolved base URLs; anything else (lookalike
//     hosts, userinfo tricks, scheme downgrades, port confusion)
//     throws EGRESS_BLOCKED. Plain http is tolerated only for
//     loopback hosts so a local dev endpoint can be exercised.
//
//   redactHeaders / redactDeep
//     Authorization and API-key material is stripped from anything
//     bound for a log line, trace, or diagnostic payload. Key-name
//     matching catches structured secrets; value matching catches
//     secrets that leak under innocent key names.
// ═══════════════════════════════════════════════════════════════

import { llmError, LLM_ERROR_CODES } from "./errors.js";

export const REDACTED = "[REDACTED]";

const SECRET_KEY_RE = /(authorization|api[-_]?key)/i;
const SECRET_VALUE_RE = /^\s*(sk-\S{3,}|xai-\S{3,}|Bearer\s+\S+)/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const MAX_REDACT_DEPTH = 12;

export function assertHostAllowed(urlString, allowedHosts) {
  let url;
  try {
    url = new URL(String(urlString));
  } catch {
    throw llmError(LLM_ERROR_CODES.EGRESS_BLOCKED, "Outbound URL is not parseable");
  }
  if (url.username || url.password) {
    throw llmError(LLM_ERROR_CODES.EGRESS_BLOCKED, "Outbound URL carries credentials", { host: url.host });
  }
  const httpsOk = url.protocol === "https:";
  const loopbackHttpOk = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!httpsOk && !loopbackHttpOk) {
    throw llmError(LLM_ERROR_CODES.EGRESS_BLOCKED, "Outbound scheme not permitted", { host: url.host });
  }
  const host = url.host.toLowerCase();
  const allowed = allowedHosts && typeof allowedHosts.has === "function" && allowedHosts.has(host);
  if (!allowed) {
    throw llmError(LLM_ERROR_CODES.EGRESS_BLOCKED, "Outbound host is not a configured LLM provider", { host });
  }
  return url;
}

export function redactHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : value;
  }
  return out;
}

function redactValue(value, depth, seen) {
  if (typeof value === "string") {
    return SECRET_VALUE_RE.test(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? "[Function]" : value;
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_REDACT_DEPTH) return "[MaxDepth]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(inner, depth + 1, seen);
  }
  return out;
}

// Deep, non-mutating copy with secrets removed. Safe on cyclic
// structures (cycles become "[Circular]").
export function redactDeep(value) {
  return redactValue(value, 0, new WeakSet());
}
