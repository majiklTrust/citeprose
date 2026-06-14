// ═══════════════════════════════════════════════════════════════
// src/services/metric-store.js — verified-metrics read interface
// ═══════════════════════════════════════════════════════════════
// The stable, single read boundary for the verified-metrics store
// (METRICS FIDELITY, feature #3). Consumption only — there is no
// write/insert path here; rows are populated out of band.
//
// Two layers, deliberately separated:
//
//   PURE SHAPING (synchronous, no DB):
//     rowToMetric(row)          DB row -> stable record, or null/throw
//                               if the value or its provenance is
//                               missing (an unsourced number is never
//                               emitted into content).
//     groupByMetricGroup(rows)  flat metrics -> [{ groupSlug,
//                               groupLabel, metrics:[...] }].
//     requireTopicRef(ref)      validate a topic id (positive int).
//
//   DB READERS (async, tenant-scoped, active-only):
//     getMetricsForTopic(id)      grouped metrics for a topic.
//     getMetricGroupsForTopic(id) the topic's metric groups.
//     getMetricByKey(key)         one metric (for token substitution).
//
// The DB layer is imported LAZILY inside the readers so the pure
// shaping helpers stay importable and unit-testable without booting
// the connection pool — which is exactly the layer boundary this
// module promises. Every reader runs on currentClient() (the RLS
// tenant-scoped transaction client) and filters enabled = TRUE, so
// row-level security is enforced and deactivated rows never surface.
// ═══════════════════════════════════════════════════════════════

// ── Pure shaping helpers ────────────────────────────────────────

export function rowToMetric(row) {
  if (!row || typeof row !== "object") return null;

  // Value must be a finite number (or a numeric string). Reject
  // null, NaN, and non-numeric strings — no unverifiable values.
  let value = null;
  if (typeof row.value === "number" && Number.isFinite(row.value)) {
    value = row.value;
  } else if (typeof row.value === "string" && row.value.trim() !== "") {
    const n = Number(row.value);
    if (Number.isFinite(n)) value = n;
  }
  if (value === null) return null;

  // Provenance is mandatory: a value without a source is not a
  // verified metric.
  const quote = typeof row.source_quote === "string" ? row.source_quote.trim() : "";
  const name = typeof row.source_name === "string" ? row.source_name.trim() : "";
  if (quote === "" || name === "") return null;

  return {
    metricKey: typeof row.metric_key === "string" ? row.metric_key : null,
    value,
    unit: typeof row.unit === "string" ? row.unit : null,
    groupSlug: typeof row.group_slug === "string" ? row.group_slug : null,
    groupLabel: typeof row.group_label === "string" ? row.group_label : null,
    enabled: row.enabled !== false,
    source: {
      quote,
      name,
      locator: typeof row.source_locator === "string" ? row.source_locator : null,
      url: typeof row.source_url === "string" ? row.source_url : null
    }
  };
}

export function groupByMetricGroup(metrics) {
  const order = [];
  const byGroup = new Map();
  for (const m of Array.isArray(metrics) ? metrics : []) {
    if (!m || typeof m !== "object") continue;
    const slug = typeof m.groupSlug === "string" ? m.groupSlug : "";
    if (!byGroup.has(slug)) {
      byGroup.set(slug, { groupSlug: slug, groupLabel: m.groupLabel || null, metrics: [] });
      order.push(slug);
    }
    byGroup.get(slug).metrics.push(m);
  }
  return order.map(s => byGroup.get(s));
}

export function requireTopicRef(ref) {
  let n = null;
  if (typeof ref === "number" && Number.isInteger(ref)) {
    n = ref;
  } else if (typeof ref === "string" && /^\d+$/.test(ref.trim())) {
    n = parseInt(ref.trim(), 10);
  }
  if (n === null || n <= 0) {
    throw new Error("requireTopicRef: a positive integer topic id is required.");
  }
  return n;
}

// ── DB readers (lazy DB binding; tenant-scoped; active-only) ─────
// SQL is written as literal strings with no ${} interpolation — every
// caller-supplied value is bound via a $N placeholder. The metric
// SELECT list is repeated in full rather than interpolated, so the
// "no dynamic SQL" rule holds without exception.

async function tenantClient() {
  // Lazy import keeps the pure helpers above importable without the
  // DB stack. Node caches the module, so this is a map lookup after
  // the first call.
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) {
    throw new Error("metric-store: no tenant client in scope — call within withTenant().");
  }
  return c;
}

export async function getMetricsForTopic(topicRef) {
  const topicId = requireTopicRef(topicRef);
  const c = await tenantClient();
  const r = await c.query(
    `SELECT v.metric_key, v.value, v.unit, v.enabled,
            v.source_quote, v.source_name, v.source_locator, v.source_url,
            g.slug AS group_slug, g.label AS group_label
     FROM metric_values v
     JOIN metric_groups g
       ON g.tenant_id = v.tenant_id AND g.id = v.group_id
     WHERE g.topic_id = $1 AND v.enabled = TRUE AND g.enabled = TRUE
     ORDER BY g.slug, v.metric_key`,
    [topicId]
  );
  const metrics = r.rows.map(rowToMetric).filter(Boolean);
  return groupByMetricGroup(metrics);
}

export async function getMetricGroupsForTopic(topicRef) {
  const topicId = requireTopicRef(topicRef);
  const c = await tenantClient();
  const r = await c.query(
    `SELECT g.id AS group_id, g.slug AS group_slug, g.label AS group_label
     FROM metric_groups g
     WHERE g.topic_id = $1 AND g.enabled = TRUE
     ORDER BY g.slug`,
    [topicId]
  );
  return r.rows.map(row => ({
    groupId: row.group_id,
    groupSlug: row.group_slug,
    groupLabel: row.group_label
  }));
}

export async function getMetricByKey(metricKey) {
  if (typeof metricKey !== "string" || metricKey.trim() === "") {
    throw new Error("getMetricByKey: a non-empty metric_key is required.");
  }
  const c = await tenantClient();
  const r = await c.query(
    `SELECT v.metric_key, v.value, v.unit, v.enabled,
            v.source_quote, v.source_name, v.source_locator, v.source_url,
            g.slug AS group_slug, g.label AS group_label
     FROM metric_values v
     JOIN metric_groups g
       ON g.tenant_id = v.tenant_id AND g.id = v.group_id
     WHERE v.metric_key = $1 AND v.enabled = TRUE
     LIMIT 1`,
    [metricKey.trim()]
  );
  return r.rows.length ? rowToMetric(r.rows[0]) : null;
}
