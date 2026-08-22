// =================================================================
// src/services/generation-trace.js - pipeline observation frame
// =================================================================
// A request scoped AsyncLocalStorage frame that lets an OBSERVER
// watch a generation run without changing how that run is
// sequenced. The pipeline keeps ownership of its own order; it
// simply announces what it assembled at each boundary.
//
// Two things ride the frame:
//
//   trace   a collector the pipeline pushes named stage records
//           into. Recording NEVER throws and never awaits, so the
//           collector cannot become the failure it is observing.
//
//   vendor  an OPTIONAL substitute for the vendor call. When
//           present, the pipeline hands its fully assembled request
//           to this object instead of the network. Everything above
//           the wire (prompt assembly, parsing, scoring, gates) runs
//           for real. When absent, the pipeline calls the vendor
//           exactly as it always has.
//
// When no frame is ambient, every accessor returns null and the
// pipeline is byte for byte the production path. Production
// requests never enter this context.
//
// Zero imports beyond node:async_hooks, so this can be imported
// anywhere without creating a cycle.
//
// The records deliberately contain assembled prompts and vendor
// responses; that visibility is the entire point. They are held in
// request memory only. They are NEVER written to the database and
// NEVER passed to platformLog.
// =================================================================
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

// 200k chars per value. A memory guard, not censorship: the clamp
// states how much it dropped so a truncated value can never be
// mistaken for a complete one.
const STRING_CLAMP = 200000;

// Values a trace can legitimately meet that JSON cannot carry. Left
// unconverted each one lies in a DIFFERENT way, and every one of
// these appears somewhere in the pipeline's argument lists:
//   Map, Set        serialize to {} and enumerate to zero keys, so a
//                   populated collection reads as empty
//   BigInt          JSON.stringify throws
//   circular        JSON.stringify throws, and the walk below would
//                   recurse forever before it got the chance
//   NaN, Infinity   become null, indistinguishable from a real null
//   function        serializes to {}
//   undefined       disappears from objects entirely
// Conversion has to happen HERE, at capture: by the time a record
// reaches the response it is already wrong.
function clamp(value, seen) {
  const visited = seen || new Set();

  if (value === undefined) return "[undefined]";
  if (value === null) return null;

  const t = typeof value;
  if (t === "string") {
    return value.length > STRING_CLAMP
      ? value.slice(0, STRING_CLAMP) + `\n[trace clamp: ${value.length - STRING_CLAMP} more chars]`
      : value;
  }
  if (t === "number") {
    if (Number.isNaN(value)) return "[NaN]";
    if (!Number.isFinite(value)) return value > 0 ? "[Infinity]" : "[-Infinity]";
    return value;
  }
  if (t === "boolean") return value;
  if (t === "bigint") return `[bigint ${value.toString()}]`;
  if (t === "function") return `[function ${value.name || "anonymous"}]`;
  if (t === "symbol") return `[symbol ${String(value)}]`;
  if (t !== "object") return String(value);

  // Cycle guard. Removed again on the way out so a value that merely
  // repeats in two branches is still shown in both.
  if (visited.has(value)) return "[circular reference]";
  visited.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) {
      return {
        __kind: "map", size: value.size,
        entries: [...value.entries()].slice(0, 200)
          .map(([k, v]) => ({ key: String(k), value: clamp(v, visited) }))
      };
    }
    if (value instanceof Set) {
      return { __kind: "set", size: value.size, values: [...value].slice(0, 200).map((v) => clamp(v, visited)) };
    }
    if (Array.isArray(value)) return value.map((v) => clamp(v, visited));
    const out = {};
    for (const key of Object.keys(value)) out[key] = clamp(value[key], visited);
    return out;
  } finally {
    visited.delete(value);
  }
}

export function createGenerationTrace() {
  const startedAt = Date.now();
  const stages = [];
  return {
    stage(name, data) {
      try {
        stages.push({
          id: String(name),
          atMs: Date.now() - startedAt,
          data: clamp(data === undefined ? null : data)
        });
      } catch {
        // Observation must never break the run. Record that we could
        // not observe, rather than losing the stage silently.
        try {
          stages.push({ id: String(name), atMs: Date.now() - startedAt, data: "[untraceable value]" });
        } catch { /* give up quietly */ }
      }
    },
    toJSON() {
      return { startedAtEpochMs: startedAt, totalMs: Date.now() - startedAt, stages };
    }
  };
}

export function runWithGenerationTrace(frame, fn) {
  return als.run(Object.freeze({ ...(frame || {}) }), fn);
}

// The collector, or null in production.
export function generationTrace() {
  const frame = als.getStore();
  return (frame && frame.trace) || null;
}

// The credential and routing an OBSERVED run must use, or null in
// production. Presence of a frame with labRun set is what tells the
// pipeline this is a Lab run and must not touch tenant credentials.
//
//   apiKey    the decrypted PLATFORM key, by ruling. A Lab run spends
//             the platform's own key, never a tenant's BYOK key and
//             never a trial grant: a developer tool must not bill a
//             customer for work they did not request.
//   provider  the provider the operator chose
//   model     the model the operator chose
export function labRun() {
  const frame = als.getStore();
  return (frame && frame.labRun) || null;
}

// A request scoped replacement for a vault prompt TEMPLATE, or null.
//
// Applied after the vault read, so it replaces the row that resolved
// whatever genre served it. Never written anywhere: the frame is gone
// when the request returns.
//
// A TEMPLATE, not an assembled prompt. Placeholder substitution still
// runs over the override, so {{RESEARCH_BLOCK}} and the rest fill from
// THIS run. An override that drops a placeholder drops that material,
// which is a legitimate thing to test.
export function promptOverride(key) {
  const frame = als.getStore();
  const overrides = frame && frame.promptOverrides;
  if (!overrides) return null;
  const text = overrides[key];
  return typeof text === "string" && text.length > 0 ? text : null;
}

// The vendor substitute, or null when the run should call the real
// vendor. Its presence is also what marks a run as observed, which
// is how the pipeline knows to skip inter-call rate limit cooldowns
// that exist only to pace real vendor traffic.
export function generationVendor() {
  const frame = als.getStore();
  return (frame && frame.vendor) || null;
}

// ── Arguments ────────────────────────────────────────────────
// Parameter names that carry a CAPABILITY and must never be shown.
// Redaction is keyed on the NAME, not on the value, so a token stays
// hidden whether or not this particular run happened to pass null.
// The parameter still appears in the list, so its presence in the
// signature is never in doubt.
//
// Matching is on WORDS, not substrings. A substring test on "key"
// would redact byKey, promptKey and cacheKey, all of which carry
// pipeline data an operator needs; a fixed list of exact names would
// miss the next parameter someone calls bearer or authHeader. So the
// name is split on camelCase and separator boundaries and each word
// is tested, with a few two-word compounds for the cases where the
// first word is what makes the second one sensitive.
const SENSITIVE_WORDS = Object.freeze(new Set([
  "token", "secret", "password", "passwd", "passphrase",
  "credential", "credentials", "bearer", "jwt", "cookie",
  "session", "sessionid", "authorization", "auth", "signature", "nonce"
]));

// "key" alone is not sensitive. These pairings are.
const SENSITIVE_PAIRS = Object.freeze([
  "api key", "private key", "signing key", "access key",
  "secret key", "encryption key", "shared key", "master key"
]);

// actionToken -> "action token"; api_key -> "api key"; APIKey -> "api key"
function nameWords(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .trim();
}

function isSensitiveName(name) {
  const phrase = nameWords(name);
  if (!phrase) return false;
  if (SENSITIVE_PAIRS.some((pair) => phrase.indexOf(pair) >= 0)) return true;
  return phrase.split(/\s+/).some((word) => SENSITIVE_WORDS.has(word));
}

// A one line label for a compound value. The rule: show the name
// when one exists, and a numeric identifier when one exists, because
// those are what let an operator recognise WHICH record they are
// looking at without expanding it.
const ID_KEY_RE = /^(id|.*_id|index|citationIndex)$/i;

// Values keep their JSON quoting. A bare name=Some Long Title makes
// the boundary between one field and the next ambiguous the moment a
// value contains a comma or an equals sign, and hides an empty
// string entirely. JSON.stringify quotes strings and leaves numbers
// bare, which is exactly the distinction wanted here.
function identify(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parts = [];
  const idKey = Object.keys(value).find((k) => ID_KEY_RE.test(k) && typeof value[k] === "number");
  if (idKey) parts.push(idKey + "=" + value[idKey]);
  if (typeof value.name === "string" && value.name) parts.push("name=" + JSON.stringify(value.name));
  return parts.length ? parts.join(", ") : null;
}

function summarise(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return value.length > 60 ? `string, ${value.length} chars` : JSON.stringify(value);
  if (t === "number" || t === "boolean" || t === "bigint") return String(value);
  if (t === "function") return `function ${value.name || "anonymous"}`;
  if (t === "symbol") return String(value);
  if (t !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return `Map, ${value.size} entries`;
  if (value instanceof Set) return `Set, ${value.size} values`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "array, empty";
    const first = identify(value[0]);
    return first ? `array, ${value.length} items, first: ${first}` : `array, ${value.length} items`;
  }
  const id = identify(value);
  const fields = Object.keys(value).length;
  return id ? `{ ${id} }` : `object, ${fields} field${fields === 1 ? "" : "s"}`;
}

function typeOf(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  return typeof value;
}

/**
 * Announce the arguments a pipeline function was called with.
 *
 * The signature is written at the call site rather than derived,
 * because Function.prototype.toString yields the implementation
 * rather than a readable declaration, and module private functions
 * are not reachable from the observer at all.
 *
 * @param {string} rowId      call sequence row this belongs to
 * @param {string} signature  the declaration, verbatim from source
 * @param {Array<[string, *]>} params  ordered [name, value] pairs.
 *        An ARRAY, not an object, so declaration order survives and
 *        two parameters can never collide on a duplicate key.
 * @param {string} [note]     for rows that are a step, not a call
 */
export function traceArguments(rowId, signature, params, note) {
  const trace = generationTrace();
  if (!trace) return;
  const described = (params || []).map((pair) => {
    const name = String((pair || [])[0]);
    if (isSensitiveName(name)) {
      return { name, type: "redacted", summary: "[redacted]", value: null };
    }
    const raw = (pair || [])[1];
    return { name, type: typeOf(raw), summary: summarise(raw), value: clamp(raw, new Set()) };
  });
  trace.stage(rowId + "_arguments", { signature, note: note || null, params: described });
}
