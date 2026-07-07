// =================================================================
// src/services/analytics-narrative.js, cited narrative (FR-P1-06)
// =================================================================
// Turns the tenant's stored analytics into an LLM narrative that
// CITES every claim (FR-CC-05). The mechanism mirrors the metric
// fidelity layer:
//
//   1. buildAnalyticsDataset reads ONLY stored values (post_metrics,
//      follower_demographics, posts/topics joins) and assigns each
//      datapoint a stable id D1..Dn.
//   2. The vault template (key: analytics_narrative, fetched via
//      getAuthorizedPrompt behind an action token) instructs the
//      model to attach [Dn] citations to every quantitative claim.
//   3. verifyNarrativeCitations enforces, ALWAYS: at least one
//      citation, and no citation id outside the dataset. Optional
//      strict mode (ANALYTICS_NARRATIVE_STRICT=1) additionally
//      polices bare numbers against the dataset values.
//   4. Any violation blocks: the narrative is withheld with a
//      reason, never rendered. No fabricated data.
//
// The LLM call goes through generateWithTenantLlm exclusively
// (FR-CC-04); this module never touches a vendor SDK.
// =================================================================

// Import discipline (LLM-layer precedent): DB-touching modules
// (with-tenant, prompt-vault) and the LLM client arrive via lazy
// dynamic import, so this module LOADS with no database environment
// and the pure citation verifier is testable DB-free.
import {
  getNarrativeMaxOutputTokens, getNarrativeDatasetCap, isNarrativeStrict,
  getDefaultWindowDays, getMaxWindowDays
} from "../config/analytics.js";

async function client() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("analytics narrative requires tenant context (withTenant)");
  return c;
}

export function clampWindowDays(days) {
  const n = parseInt(String(days ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return getDefaultWindowDays();
  return Math.min(n, getMaxWindowDays());
}

// ── Dataset (stored values only) ──────────────────────────────
export async function buildAnalyticsDataset(windowDays) {
  const days = clampWindowDays(windowDays);
  const cap = getNarrativeDatasetCap();
  const c = await client();
  const points = [];
  const add = (label, value) => {
    if (points.length >= cap) return;
    points.push({ id: `D${points.length + 1}`, label, value: String(value) });
  };

  const totals = await c.query(
    `SELECT COUNT(*)::bigint AS posts,
            SUM(pm.impressions)::bigint AS impressions,
            SUM(pm.clicks)::bigint AS clicks,
            SUM(pm.likes + pm.comments + pm.shares)::bigint AS interactions
       FROM post_metrics pm
       JOIN posts p ON p.tenant_id = pm.tenant_id AND p.id = pm.post_id
      WHERE p.posted_at >= now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  const t = totals.rows[0] || {};
  add(`posts with retrieved metrics, last ${days} days`, t.posts ?? 0);
  if (t.impressions !== null && t.impressions !== undefined) add("total impressions", t.impressions);
  if (t.clicks !== null && t.clicks !== undefined) add("total clicks", t.clicks);
  if (t.interactions !== null && t.interactions !== undefined) add("total interactions (likes+comments+shares)", t.interactions);

  const byTopic = await c.query(
    `SELECT tp.name AS topic,
            COUNT(*)::bigint AS posts,
            SUM(pm.impressions)::bigint AS impressions,
            SUM(pm.likes + pm.comments + pm.shares)::bigint AS interactions
       FROM post_metrics pm
       JOIN posts p  ON p.tenant_id = pm.tenant_id AND p.id = pm.post_id
       LEFT JOIN topics tp ON tp.tenant_id = p.tenant_id AND tp.id = p.topic_id
      WHERE p.posted_at >= now() - ($1 || ' days')::interval
      GROUP BY tp.name
      ORDER BY SUM(pm.impressions) DESC NULLS LAST`,
    [String(days)]
  );
  for (const row of byTopic.rows) {
    const name = row.topic || "(no topic)";
    add(`topic "${name}" posts`, row.posts);
    if (row.impressions !== null) add(`topic "${name}" impressions`, row.impressions);
    if (row.interactions !== null) add(`topic "${name}" interactions`, row.interactions);
  }

  const topDemo = await c.query(
    `SELECT facet, entity, follower_count
       FROM follower_demographics
      ORDER BY follower_count DESC
      LIMIT 6`
  );
  for (const row of topDemo.rows) {
    add(`followers, ${row.facet} ${row.entity}`, row.follower_count);
  }

  return { days, points };
}

export function formatDataBlock(points) {
  return points.map((p) => `${p.id}: ${p.label} = ${p.value}`).join("\n");
}

// ── Citation fidelity (pure, exported for the test suite) ─────
const CITATION_RE = /\[(D\d+)\]/g;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

export function verifyNarrativeCitations(text, points, { strict = false, windowDays = null } = {}) {
  const violations = [];
  const known = new Set(points.map((p) => p.id));
  const cited = new Set();
  let m;
  while ((m = CITATION_RE.exec(String(text))) !== null) {
    cited.add(m[1]);
    if (!known.has(m[1])) violations.push(`unknown citation [${m[1]}]`);
  }
  if (cited.size === 0) violations.push("narrative carries no [Dn] citations");

  if (strict) {
    const allowed = new Set();
    for (const p of points) {
      const clean = String(p.value).replace(/,/g, "");
      allowed.add(clean);
      allowed.add(Number(clean).toLocaleString("en-US"));
    }
    if (windowDays !== null) allowed.add(String(windowDays));
    const body = String(text).replace(CITATION_RE, " ");
    let n;
    while ((n = NUMBER_RE.exec(body)) !== null) {
      const raw = n[0];
      if (!allowed.has(raw) && !allowed.has(raw.replace(/,/g, ""))) {
        violations.push(`number "${raw}" is not a stored data point`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

// ── Generation ────────────────────────────────────────────────
// Returns { blocked:true, reason } on any fidelity violation,
// { notConfigured:true } when the vault key is absent, else
// { narrative, dataPoints, provider, model }.
export async function generateAnalyticsNarrative(actionToken, windowDays) {
  const dataset = await buildAnalyticsDataset(windowDays);
  if (dataset.points.length === 0) {
    return { blocked: true, reason: "No retrieved metrics exist for this window yet. Run a sync first." };
  }

  const { getAuthorizedPrompt, renderPrompt } = await import("./prompt-vault.js");
  const template = await getAuthorizedPrompt("analytics_narrative", actionToken);
  if (!template) {
    return { notConfigured: true };
  }

  const userPrompt = renderPrompt(template, {
    WINDOW_DAYS: String(dataset.days),
    DATA_BLOCK: formatDataBlock(dataset.points)
  });

  const { generateWithTenantLlm } = await import("../llm/client.js");
  const result = await generateWithTenantLlm({
    system: null,
    user: userPrompt,
    maxOutputTokens: getNarrativeMaxOutputTokens(),
    temperature: null,
    purpose: "analytics-narrative"
  });

  const check = verifyNarrativeCitations(result.text, dataset.points, {
    strict: isNarrativeStrict(), windowDays: dataset.days
  });
  if (!check.ok) {
    return {
      blocked: true,
      reason: "Narrative withheld: " + check.violations.slice(0, 3).join("; ")
    };
  }
  return {
    narrative: result.text,
    dataPoints: dataset.points,
    windowDays: dataset.days,
    provider: result.provider,
    model: result.model
  };
}
