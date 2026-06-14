// ═══════════════════════════════════════════════════════════════
// src/services/metric-content.js — metric fidelity layer (pure)
// ═══════════════════════════════════════════════════════════════
// Sits between the verified-metrics store and the LLM output to lock
// the fidelity of numbers in a generated post. Pure (zero imports):
// no DB, no network, no LLM — fully unit-testable.
//
//   buildMetricBlock(groups)
//     Renders the topic's verified metrics into a prompt block. Each
//     metric is listed as a {{METRIC_<key>}} token with its value,
//     unit, and source, and the model is told to write the TOKEN in
//     place of the number. Returns "" when there are no metrics, so
//     a metric-free topic falls back to research-only generation with
//     no metric instructions at all.
//
//   substituteMetricTokens(text, byKey)
//     Replaces every {{METRIC_<key>}} the model emitted with the
//     EXACT stored value (structural fidelity — the model never types
//     the digits). Unknown or non-numeric keys are left intact and
//     reported, never silently dropped. byKey is a Map<key, metric>.
//
//   extractNumericTokens(text)
//     Pulls numeric literals from text (commas and a trailing percent
//     tolerated) for the verifier's allowlist comparison.
//
//   verifyMetricFidelity(text, byKey, options)
//     Token integrity (no unknown {{METRIC_...}} left) ALWAYS. When
//     options.strict is set, also requires every number in the post
//     to match a verified metric value OR an entry in
//     options.allowedNumbers (e.g. numbers already present in the
//     research material). Returns { ok, unknownTokens, unverifiedNumbers }.
//
// Token grammar: {{METRIC_<key>}} where <key> is any run of
// non-brace characters, so any metric_key the store allows is
// matched. The renderPrompt templating is single-pass and never
// reprocesses model output, so these tokens cannot collide with it.
// ═══════════════════════════════════════════════════════════════

var TOKEN_RE = /\{\{METRIC_([^}]+)\}\}/g;
var NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;
var EPSILON = 1e-9;

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    var n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function buildMetricBlock(groups) {
  var gs = Array.isArray(groups) ? groups : [];
  var lines = [];
  var total = 0;
  for (var i = 0; i < gs.length; i++) {
    var g = gs[i];
    if (!g || !Array.isArray(g.metrics) || g.metrics.length === 0) continue;
    var groupLines = [];
    for (var j = 0; j < g.metrics.length; j++) {
      var m = g.metrics[j];
      if (!m || typeof m.metricKey !== "string") continue;
      var n = toFiniteNumber(m.value);
      if (n === null) continue;
      var unit = m.unit ? " " + m.unit : "";
      var src = m.source && m.source.name ? " — " + m.source.name : "";
      groupLines.push("- {{METRIC_" + m.metricKey + "}} = " + n + unit + src);
      total++;
    }
    if (groupLines.length) {
      if (g.groupLabel) lines.push(String(g.groupLabel));
      for (var k = 0; k < groupLines.length; k++) lines.push(groupLines[k]);
      lines.push("");
    }
  }
  if (total === 0) return "";
  var header = "VERIFIED METRICS — when you state one of these figures, write its {{METRIC_key}} token exactly, in place of the number. Do not type the number yourself; the system substitutes the exact verified value after you write. Use only metrics that fit the angle; you need not use all of them.";
  return header + "\n\n" + lines.join("\n").replace(/\s+$/, "");
}

export function substituteMetricTokens(text, byKey) {
  var t = typeof text === "string" ? text : "";
  var substituted = [];
  var unknownTokens = [];
  var has = byKey && typeof byKey.has === "function";
  var out = t.replace(TOKEN_RE, function (match, key) {
    if (has && byKey.has(key)) {
      var n = toFiniteNumber(byKey.get(key).value);
      if (n !== null) { substituted.push(key); return String(n); }
    }
    unknownTokens.push(key);
    return match;
  });
  return { text: out, substituted: substituted, unknownTokens: unknownTokens };
}

export function extractNumericTokens(text) {
  if (typeof text !== "string") return [];
  var out = [];
  var m;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    var n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function verifyMetricFidelity(text, byKey, options) {
  var opts = options || {};
  var t = typeof text === "string" ? text : "";
  var has = byKey && typeof byKey.has === "function";

  var unknownTokens = [];
  var m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(t)) !== null) {
    var key = m[1];
    if (!(has && byKey.has(key))) unknownTokens.push(key);
  }

  var unverifiedNumbers = [];
  if (opts.strict) {
    var allowed = [];
    if (byKey && typeof byKey.forEach === "function") {
      byKey.forEach(function (mt) {
        var n = toFiniteNumber(mt && mt.value);
        if (n !== null) allowed.push(n);
      });
    }
    var extra = Array.isArray(opts.allowedNumbers) ? opts.allowedNumbers : [];
    for (var i = 0; i < extra.length; i++) {
      if (Number.isFinite(extra[i])) allowed.push(extra[i]);
    }
    var nums = extractNumericTokens(t);
    for (var j = 0; j < nums.length; j++) {
      var v = nums[j];
      var ok = false;
      for (var a = 0; a < allowed.length; a++) {
        if (Math.abs(allowed[a] - v) < EPSILON) { ok = true; break; }
      }
      if (!ok) unverifiedNumbers.push(v);
    }
  }

  return {
    ok: unknownTokens.length === 0 && unverifiedNumbers.length === 0,
    unknownTokens: unknownTokens,
    unverifiedNumbers: unverifiedNumbers
  };
}
