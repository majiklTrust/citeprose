// ═══════════════════════════════════════════════════════════════
// src/services/search-queries.js — per-topic research queries
// ═══════════════════════════════════════════════════════════════
// Pure, DB-free replacement for the removed buildSearchQueries():
// search queries are per-topic DATA (topics.search_templates)
// resolved through ONE path for every topic — no privileged slugs.
//
//   buildQueriesForTopic(topic, angle)
//     1. Render topic.search_templates (the author-tuned path).
//     2. When none render, derive fallback queries from the topic's
//        name/description plus the angle's keywords.
//
// Placeholders (the only four): {{ANGLE}} {{KEYWORDS}} {{YEAR_RANGE}}
// {{TOPIC_NAME}}. The "General discussion" default angle contributes
// NOTHING to queries — an unauthored angle must not poison retrieval.
//
// Zero Trust: templates are tenant-authored text that is rendered
// into the research prompt as numbered, quoted queries. Two layers:
//   save     — validateSearchTemplates() gates PATCH /topics/:id
//              (structure, caps, no control chars, placeholder
//              whitelist) with explicit rejection reasons;
//   render   — sanitizeQuery() strips control characters and double
//              quotes, collapses whitespace, and caps length, so
//              even data written directly to the DB cannot break
//              out of the prompt's query framing.
// ═══════════════════════════════════════════════════════════════

const ALLOWED_PLACEHOLDERS = new Set(["ANGLE", "KEYWORDS", "YEAR_RANGE", "TOPIC_NAME"]);
const MAX_TEMPLATES = 5;
const MAX_TEMPLATE_LENGTH = 200;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_ANGLE = "general discussion"; // compared after normalization

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was",
  "has", "have", "been", "being", "will", "would", "could", "should",
  "their", "about", "into", "through", "during", "before", "after"
]);

const PLACEHOLDER_RE = /\{\{([^}]*)\}\}/g;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

// ── helpers ──────────────────────────────────────────────────

function extractSearchKeywords(text) {
  if (typeof text !== "string") return "";
  return text.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 5).join(" ");
}

// Render-time sanitation: a query must stay a single, plain line.
function sanitizeQuery(s) {
  let out = String(s)
    .replace(/[\u0000-\u001F\u007F"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > MAX_QUERY_LENGTH) out = out.slice(0, MAX_QUERY_LENGTH).trim();
  return out;
}

function unknownPlaceholder(template) {
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!ALLOWED_PLACEHOLDERS.has(m[1])) return m[1] || "(empty)";
  }
  return null;
}

// ── validateSearchTemplates ──────────────────────────────────
// Save-boundary gate. Nothing is silently dropped or repaired:
// violations return { ok:false, reason } so the UI can tell the
// author exactly what to fix. null/undefined/[] mean "no templates".
export function validateSearchTemplates(input) {
  if (input === null || input === undefined) return { ok: true, templates: [] };
  if (!Array.isArray(input)) {
    return { ok: false, reason: "search_templates must be an array of strings" };
  }
  if (input.length > MAX_TEMPLATES) {
    return { ok: false, reason: `At most ${MAX_TEMPLATES} search templates are allowed` };
  }
  const templates = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (typeof raw !== "string") {
      return { ok: false, reason: `Template ${i + 1} must be a string` };
    }
    const t = raw.trim();
    if (t.length === 0) {
      return { ok: false, reason: `Template ${i + 1} is empty` };
    }
    if (t.length > MAX_TEMPLATE_LENGTH) {
      return { ok: false, reason: `Template ${i + 1} exceeds ${MAX_TEMPLATE_LENGTH} characters` };
    }
    if (CONTROL_RE.test(t)) {
      return { ok: false, reason: `Template ${i + 1} contains control characters` };
    }
    const bad = unknownPlaceholder(t);
    if (bad !== null) {
      return { ok: false, reason: `Template ${i + 1} uses unknown placeholder {{${bad}}} — allowed: ANGLE, KEYWORDS, YEAR_RANGE, TOPIC_NAME` };
    }
    templates.push(t);
  }
  return { ok: true, templates };
}

// ── renderSearchTemplate ─────────────────────────────────────
// Substitutes the four placeholders from ctx and sanitizes the
// result. Returns the query string, or null when the template
// carries an unknown placeholder (fail-closed) or renders empty.
export function renderSearchTemplate(template, ctx) {
  if (typeof template !== "string") return null;
  if (unknownPlaceholder(template) !== null) return null;
  const c = ctx || {};
  const rendered = template.replace(PLACEHOLDER_RE, (_, name) => {
    const v = c[name];
    return typeof v === "string" ? v : "";
  });
  const out = sanitizeQuery(rendered);
  return out.length > 0 ? out : null;
}

// ── buildQueriesForTopic / buildQueriesForTopicDetailed ─────
// The single query source for research. Never throws on junk
// stored data; always returns 1..5 sanitized query strings.
// The detailed variant additionally RETURNS provenance — which
// path produced the queries and the actual context values — so
// CALLERS can log it. This module itself stays console-silent.
export function buildQueriesForTopic(topic, angle) {
  return buildQueriesForTopicDetailed(topic, angle).queries;
}

export function buildQueriesForTopicDetailed(topic, angle) {
  const t = topic || {};
  const topicName =
    (typeof t.name === "string" && t.name.trim()) ? t.name.trim()
      : (t.slug ? String(t.slug).replace(/-/g, " ").trim() : "business news");
  const description = typeof t.description === "string" ? t.description : "";

  const year = new Date().getFullYear();
  const yearRange = `${year - 1} ${year}`;

  // The unauthored default angle contributes nothing to retrieval.
  const angleText = typeof angle === "string" ? angle.trim() : "";
  const effectiveAngle =
    angleText && angleText.toLowerCase().replace(/\s+/g, " ") !== DEFAULT_ANGLE
      ? angleText : "";

  const keywords = effectiveAngle
    ? extractSearchKeywords(effectiveAngle)
    : extractSearchKeywords(`${topicName} ${description}`);

  const ctx = {
    ANGLE: effectiveAngle,
    KEYWORDS: keywords,
    YEAR_RANGE: yearRange,
    TOPIC_NAME: topicName
  };

  // Path 1: author-tuned templates.
  const stored = Array.isArray(t.search_templates) ? t.search_templates : [];
  const rendered = [];
  for (const tpl of stored) {
    if (typeof tpl !== "string") continue;
    const q = renderSearchTemplate(tpl, ctx);
    if (q && !rendered.includes(q)) rendered.push(q);
  }
  if (rendered.length > 0) {
    return { queries: rendered.slice(0, MAX_TEMPLATES), source: "templates", context: ctx };
  }

  // Path 2: derived fallback (no topic is worse off than today).
  const candidates = [
    `${topicName} ${keywords} ${yearRange}`,
    `${keywords} ${topicName} case study analysis`,
    `${topicName} ${keywords} expert report`
  ];
  const fallback = [];
  for (const cand of candidates) {
    const q = sanitizeQuery(cand);
    if (q && !fallback.includes(q)) fallback.push(q);
  }
  return { queries: fallback, source: "derived", context: ctx };
}

// ── parseSuggestedTemplates ──────────────────────────────────
// Gate for LLM-suggested templates: the model is an untrusted input
// source, so its reply passes the SAME validation as human and API
// input. Strips code fences, requires a strict JSON array, keeps
// only entries that individually pass validateSearchTemplates,
// dedupes, caps at MAX_TEMPLATES. Anything unparseable -> [].
export function parseSuggestedTemplates(rawText) {
  if (typeof rawText !== "string") return [];
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const entry of parsed) {
    if (out.length >= MAX_TEMPLATES) break;
    if (typeof entry !== "string") continue;
    const v = validateSearchTemplates([entry]);
    if (!v.ok) continue;
    const t = v.templates[0];
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
