// ═══════════════════════════════════════════════════════════════
// src/tenant/topic-store.js — topic lifecycle management
// ═══════════════════════════════════════════════════════════════
// All functions run inside withTenant (RLS-scoped). Topics are
// either global (user_sub = NULL, owner-managed) or personal
// (user_sub set, managed by the individual owner/editor).
//
// Content generation pool for a user: global + that user's personal.
// ═══════════════════════════════════════════════════════════════

import { currentClient } from "../db/with-tenant.js";

// ── Slug generation ──────────────────────────────────────────

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Column list for SELECT (excludes system_context) ─────────
// system_context is internal prompt engineering — never exposed
// to the client. Use FULL_COLUMNS when the caller needs it
// (content generation), CLIENT_COLUMNS for API responses.

const CLIENT_COLUMNS = `
  id, tenant_id, slug, name, description, user_sub,
  content_angles, hashtags, search_templates,
  weight, max_age_days, sort_order, enabled,
  created_at, updated_at
`;

const FULL_COLUMNS = `
  id, tenant_id, slug, name, description, user_sub,
  system_context, content_angles, hashtags, search_templates,
  weight, max_age_days, sort_order, enabled,
  created_at, updated_at
`;

// ── Reads ────────────────────────────────────────────────────

/**
 * List topics visible to a user for the management page.
 * Owner sees all. Editor sees global + own personal.
 * Returns client-safe columns (no system_context).
 */
export async function listTopicsForUser(userSub, hasManageAll) {
  const c = currentClient();
  if (hasManageAll) {
    // Owner: all topics in tenant
    const r = await c.query(
      `SELECT ${CLIENT_COLUMNS} FROM topics
       ORDER BY sort_order, created_at`
    );
    return r.rows;
  }
  // Editor: global + own personal
  const r = await c.query(
    `SELECT ${CLIENT_COLUMNS} FROM topics
     WHERE user_sub IS NULL OR user_sub = $1
     ORDER BY sort_order, created_at`,
    [userSub]
  );
  return r.rows;
}

/**
 * Get topics for content generation — includes system_context.
 * Returns global topics + the user's personal topics, enabled only.
 */
export async function getTopicsForGeneration(userSub) {
  const c = currentClient();
  const r = await c.query(
    `SELECT ${FULL_COLUMNS} FROM topics
     WHERE enabled = true
       AND (user_sub IS NULL OR user_sub = $1)
     ORDER BY sort_order, created_at`,
    [userSub]
  );
  return r.rows;
}

/**
 * Get a single topic by slug — includes system_context.
 * Used by content-generator and research for topic lookup.
 */
export async function getTopicBySlug(slug) {
  const c = currentClient();
  const r = await c.query(
    `SELECT ${FULL_COLUMNS} FROM topics WHERE slug = $1`,
    [slug]
  );
  return r.rows[0] || null;
}

/**
 * Get a single topic by ID — includes system_context.
 */
export async function getTopicById(id) {
  const c = currentClient();
  const r = await c.query(
    `SELECT ${FULL_COLUMNS} FROM topics WHERE id = $1`,
    [parseInt(id)]
  );
  return r.rows[0] || null;
}

// ── Writes ───────────────────────────────────────────────────

/**
 * Create a topic. Auto-generates slug from name.
 * scope: 'global' (user_sub = NULL) or 'personal' (user_sub = callerSub).
 * Returns the created row (client-safe columns).
 */
export async function createTopic({
  name, description, contentAngles, hashtags, systemContext,
  weight, scope, callerSub
}) {
  const c = currentClient();
  const slug = generateSlug(name);
  const userSub = scope === "global" ? null : callerSub;

  const r = await c.query(
    `INSERT INTO topics
       (tenant_id, slug, name, description, user_sub,
        system_context, content_angles, hashtags, weight)
     VALUES
       (current_tenant_id(), $1, $2, $3, $4,
        $5, $6::jsonb, $7::jsonb, $8)
     RETURNING ${CLIENT_COLUMNS}`,
    [
      slug, name, description || "", userSub,
      systemContext || "",
      JSON.stringify(contentAngles || []),
      JSON.stringify(hashtags || []),
      weight || 1
    ]
  );
  return r.rows[0];
}

/**
 * Update a topic. Only updates fields that are provided.
 * Returns the updated row (client-safe columns).
 */
export async function updateTopic(id, fields) {
  const c = currentClient();
  const sets = [];
  const params = [];
  let idx = 1;

  const allowedFields = {
    name: "name",
    description: "description",
    content_angles: "content_angles",
    hashtags: "hashtags",
    system_context: "system_context",
    weight: "weight",
    sort_order: "sort_order",
    max_age_days: "max_age_days",
    search_templates: "search_templates"
  };

  for (const [key, col] of Object.entries(allowedFields)) {
    if (key in fields) {
      const val = fields[key];
      if (["content_angles", "hashtags", "search_templates"].includes(key)) {
        sets.push(`${col} = $${idx}::jsonb`);
        params.push(JSON.stringify(val));
      } else {
        sets.push(`${col} = $${idx}`);
        params.push(val);
      }
      idx++;
    }
  }

  if (sets.length === 0) return null;

  sets.push(`updated_at = now()`);
  params.push(parseInt(id));

  const r = await c.query(
    `UPDATE topics SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING ${CLIENT_COLUMNS}`,
    params
  );
  return r.rows[0] || null;
}

/**
 * Toggle a topic's enabled state.
 */
export async function toggleTopic(id, enabled) {
  const c = currentClient();
  const r = await c.query(
    `UPDATE topics SET enabled = $1, updated_at = now()
     WHERE id = $2
     RETURNING ${CLIENT_COLUMNS}`,
    [enabled, parseInt(id)]
  );
  return r.rows[0] || null;
}

/**
 * Delete a topic by ID.
 */
export async function deleteTopic(id) {
  const c = currentClient();
  const r = await c.query(
    `DELETE FROM topics WHERE id = $1 RETURNING id`,
    [parseInt(id)]
  );
  return r.rowCount > 0;
}
