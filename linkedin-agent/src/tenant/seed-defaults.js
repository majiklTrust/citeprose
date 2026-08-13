// ═══════════════════════════════════════════════════════════════
// src/tenant/seed-defaults.js — Catchall feeds for new tenants
// ═══════════════════════════════════════════════════════════════
// Called inside withTenant during registration. Seeds broad-
// coverage RSS feeds that serve ANY topic the tenant creates.
// No feed_topics mappings needed — the is_catchall flag causes
// these feeds to be included in all topic article queries.
//
// The tenant starts with zero topics. They create their own
// through the Topics page. Every topic immediately has research
// material from these catchall feeds.
//
// Feed metadata (feed_description, feed_categories) is populated
// automatically during the first RSS poll — not at seed time.
//
// Zero Trust:
//   • Runs only inside withTenant — cannot target wrong tenant
//   • Uses current_tenant_id() for all tenant_id values
//   • All queries are parameterized — no string interpolation
//   • Data is from frozen constants — no external input
//   • ON CONFLICT DO NOTHING — fully idempotent
// ═══════════════════════════════════════════════════════════════

import { currentClient } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { tryBookkeeping } from "../db/savepoint.js";

// ── Catchall Feeds ───────────────────────────────────────────
// Broad-coverage feeds chosen for:
//   • Reliable, well-maintained RSS endpoints
//   • Content spanning technical and non-technical audiences
//   • Industry-agnostic coverage (not niche to one vertical)
//   • Article summaries in RSS (not just headlines)
//   • LinkedIn-appropriate depth (professional, analytical)
//
// Categories:
//   Technology (broad)     — MIT Tech Review, Wired, Ars Technica, The Verge, ZDNet
//   Business & Strategy    — Fast Company
//   Global News            — BBC Technology, NPR Technology
//   Science & Research     — Nature News
//   Healthcare             — STAT News

const CATCHALL_FEEDS = Object.freeze([
  // ── Technology (broad) ─────────────────────────────────────
  {
    url: "https://www.technologyreview.com/feed/",
    name: "MIT Technology Review",
    tier: "primary",
    refresh: 240
  },
  {
    url: "https://www.wired.com/feed/rss",
    name: "Wired",
    tier: "secondary",
    refresh: 120
  },
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    name: "Ars Technica",
    tier: "primary",
    refresh: 120
  },
  {
    url: "https://www.theverge.com/rss/index.xml",
    name: "The Verge",
    tier: "secondary",
    refresh: 120
  },
  {
    url: "https://www.zdnet.com/news/rss.xml",
    name: "ZDNet",
    tier: "secondary",
    refresh: 120
  },

  // ── Business & Strategy ────────────────────────────────────
  {
    url: "https://www.fastcompany.com/latest/rss",
    name: "Fast Company",
    tier: "secondary",
    refresh: 180
  },

  // ── Global News ────────────────────────────────────────────
  {
    url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
    name: "BBC Technology",
    tier: "primary",
    refresh: 180
  },
  {
    url: "https://feeds.npr.org/1019/rss.xml",
    name: "NPR Technology",
    tier: "primary",
    refresh: 240
  },

  // ── Science & Research ─────────────────────────────────────
  {
    url: "https://www.nature.com/nature.rss",
    name: "Nature News",
    tier: "primary",
    refresh: 360
  },

  // ── Healthcare & Life Sciences ─────────────────────────────
  {
    url: "https://www.statnews.com/feed/",
    name: "STAT News",
    tier: "primary",
    refresh: 240
  }
]);

// ── Seed Function ────────────────────────────────────────────

function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("seedTenantDefaults requires tenant context (call inside withTenant)");
  }
  return c;
}

/**
 * Insert catchall feeds for the current tenant. These feeds
 * serve all topics without explicit feed_topics mappings.
 * Idempotent — safe to call multiple times.
 * Must be called inside withTenant.
 *
 * @returns {{ feeds: number }}
 */
export async function seedTenantDefaults() {
  const c = client();
  let inserted = 0;

  for (const f of CATCHALL_FEEDS) {
    const result = await c.query(
      `INSERT INTO feeds_v2
         (tenant_id, url, name, tier, refresh_minutes, is_catchall)
       VALUES
         (current_tenant_id(), $1, $2, $3::feed_tier, $4, true)
       ON CONFLICT (tenant_id, url) DO NOTHING`,
      [f.url, f.name, f.tier, f.refresh]
    );
    if (result.rowCount > 0) inserted++;
  }

  // Post-seed validation — validate each feed and record results.
  // Non-blocking: feeds are kept regardless of validation outcome.
  // The validation_action setting in agent_state controls behavior.
  if (inserted > 0) {
    try {
      const { validateFeed, formatValidationMessage } = await import("../services/feed-validator.js");
      const feedsResult = await c.query(
        `SELECT id, url, name FROM feeds_v2
         WHERE is_catchall = true AND last_validated_at IS NULL`
      );

      const grades = { A: 0, B: 0, C: 0, F: 0 };
      for (const row of feedsResult.rows) {
        const v = await validateFeed(row.url);
        grades[v.grade]++;

        // 3.25111.1: was a bare catch with an empty body. In
        // PostgreSQL a failed statement ABORTS the enclosing
        // transaction, so swallowing the error here left every
        // later statement in this registration seed failing with
        // 25P02 while looking like a success. Same containment the
        // feed poll adopted (savepoint.js increment 1): the write
        // is isolated so it can actually succeed, and a real
        // failure is recorded instead of discarded.
        await tryBookkeeping(c, `seed-validate:${row.id}`, () =>
          c.query(
            `UPDATE feeds_v2
             SET last_validation_grade = $1,
                 last_validated_at = now(),
                 consecutive_failures = CASE WHEN $1 = 'F' THEN 1 ELSE 0 END
             WHERE id = $2`,
            [v.grade, row.id]
          )
        );

        platformLog("info", "seed_feed_validated", {
          feed: row.name, message: formatValidationMessage(v)
        });
      }

      platformLog("info", "seed_validation_summary", {
        total: feedsResult.rows.length, ...grades
      });
    } catch (valErr) {
      platformLog("warn", "seed_validation_skipped", {
        error: valErr.message.substring(0, 200)
      });
    }
  }

  return { feeds: inserted };
}

/**
 * Returns the list of catchall feed definitions.
 * Useful for display or diagnostics — no database call.
 */
export function getCatchallFeedList() {
  return CATCHALL_FEEDS.map(f => ({
    name: f.name,
    url: f.url,
    tier: f.tier,
    refresh: f.refresh
  }));
}
