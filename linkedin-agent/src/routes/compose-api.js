// ═══════════════════════════════════════════════════════════════
// compose-api.js   (Composer feature — Cycle 2)
// ═══════════════════════════════════════════════════════════════
// The Composer's OWN generation entry point, mounted at /api/compose.
// Deliberately decoupled from the Preview workflow (/api/generate-
// preview in api.js): separate router, separate handler, no shared
// glue. Both paths lean on the same STABLE primitives — generatePost,
// createActionToken, withTenant — but neither imports the other, so a
// future change here cannot reach Preview.
//
// Cycle 2 scope: validate a requested genre at the boundary (Zero
// Trust) and generate a draft from that genre's content_generator
// template. The draft is returned, not yet persisted — the Composer's
// own save/quality/approval flow lands in a later cycle. Genre reaches
// ONLY the content_generator template (enforced inside generatePost);
// research, verification, and injection-defense prompts stay invariant.
//
// 4.25111.96: the record a composed post stores and the primary
// source it is attributed to come from services/post-assembly.js,
// one more of the stable primitives named above (like generatePost),
// shared with Preview and the automated cycle. Still no import of
// api.js, still the same refusal of a sourceless post.
// ═══════════════════════════════════════════════════════════════

import { suspendedWriteGuard } from "../services/entitlements.js";
import { resolveTenantLlmSelection } from "../llm/client.js";
import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { createActionToken } from "../services/prompt-actions.js";
import { genreExists, listGenresForKey, templateUsesMetricBlock } from "../services/prompt-vault.js";
import { getTopicBySlug } from "../tenant/topic-store.js";
import { getMetricsForTopic } from "../services/metric-store.js";
import { createPost, logActivity, getPost } from "../services/database.js";
import { resolvePrimarySource, buildStoredContext } from "../services/post-assembly.js";
import { annotateActivation } from "../spend/activation-middleware.js";

const router = Router();
router.use(annotateActivation("compose"));

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

// Authenticated + tenant-scoped for every Composer route.
router.use(requireAuth);
router.use(resolveTenant);
// Payments (2.3.4), ruling (3): outside good standing the tenant
// is read-only. Mutating verbs deny here; billing stays exempt.
router.use(suspendedWriteGuard());


// Zero Trust: every Composer response carries tenant-derived data
// (drafts, verbatim metric values, citations, genre metadata). None of
// it is cacheable — forbid storage by the browser and any intermediary
// so a shared cache can never serve one tenant's data to another, and
// stale authorization-derived results are never replayed. Applied once
// at the router boundary rather than per-handler so the policy cannot
// be forgotten on a future route.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Mirrors the DB CHECK in 19-prompt-genre.sql. 'default' is valid.
const GENRE_RE = /^[a-z][a-z0-9_]{1,31}$/;

// Internal genre reserved for the Rewrite (refine) prompt. It lives under
// the content_generator key so it's editable in the same platform-admin
// screen as the others, but it is NOT a user-selectable content style — so
// it is filtered out of the Composer's genre menu below, server-side (Zero
// Trust: it never reaches the client). The refine route fetches it by this
// exact key. Centralized so the reserved name has one home; this is the one
// hardcoded value introduced for Rewrite — promote to config later.
const INTERNAL_REFINE_GENRE = "refine";

// POST /api/compose/generate
// Body: { topicId?, angle?, genre? }
// Generates a draft from the chosen genre and returns it. Does not
// persist — saving is a later Composer cycle.
router.post("/generate", requirePermission("preview_post"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    const angle = typeof req.body.angle === "string" ? req.body.angle : null;
    const rawGenre = typeof req.body.genre === "string" ? req.body.genre.trim() : "";
    const genre = rawGenre || "default";

    // Boundary validation: format first, then existence. Reject an
    // unknown genre outright rather than silently using default — the
    // operator picked it, so a wrong pick should be visible. 'default'
    // is guaranteed to exist (the base template) so it skips the lookup.
    if (!GENRE_RE.test(genre)) {
      return res.status(400).json({ error: "Invalid genre format." });
    }
    if (genre !== "default") {
      const exists = await genreExists("content_generator", genre);
      if (!exists) {
        return res.status(400).json({ error: "Unknown genre: " + genre });
      }
    }

    platformLog("info", "compose_generate_requested", {
      user: req.user.sub, topicId, genre, hasAngle: !!angle
    });

    const actionToken = createActionToken("generate-content", req.user.sub);

    // Mirror the Generate (Preview) flow so a composed post is PERSISTED
    // immediately as a draft — generate -> resolve primary source (fail
    // closed) -> quality check -> auto-save. The chosen genre is threaded
    // into generation and recorded on the saved row. A fidelity or
    // no-source stop returns { blocked } and saves nothing.
    const result = await withTenant(req.tenant.id, async () => {
      const g = await generatePost(topicId, null, actionToken, angle, genre);
      if (g.blocked) return { generated: g, quality: null, postId: null };

      const primarySource = resolvePrimarySource(g);
      if (!primarySource) {
        await logActivity("info", "compose_blocked_no_primary_source", { cycleId: g.cycleId, topicId: g.topicId }, req.user?.sub || null);
        return {
          generated: { blocked: true, reason: "No attributable primary source could be resolved", topicId: g.topicId, angle: g.angle, fidelity: g.fidelity || null },
          quality: null, postId: null
        };
      }

      const q = await qualityCheck(g.content, g.researchSummary, null, actionToken);

      const postId = await createPost({
        topicId: g.topicId,
        title: g.title,
        content: g.content,
        hashtags: g.hashtags || [],
        newsContext: buildStoredContext({ generated: g, quality: q, primarySource }),
        scheduledFor: null,
        imageUrl: null,
        genre
      });

      await logActivity("info", "compose_auto_saved", { postId, title: g.title, topicId: g.topicId, genre }, req.user?.sub || null);

      // The stamped destination rides the response so the preview
      // modal can render the badge without a second fetch: the row
      // is the source of truth, not a re-read of the card.
      const stored = await getPost(postId);
      return { generated: g, quality: q, postId, publishTarget: stored?.publish_target ?? null };
    });

    // A blocked result (fidelity or no primary source) saves nothing and
    // is surfaced as a normal response, not a 500.
    if (result.generated.blocked) {
      return res.json({
        blocked: true, reason: result.generated.reason,
        topicId: result.generated.topicId, angle: result.generated.angle, genre,
        fidelity: result.generated.fidelity || null
      });
    }

    // 2.5.82: same contract as generate-preview (2.5.69): a fresh
    // preview CARRIES the attachment property so the panel's
    // staleness check cannot false-fire. A just-created draft's
    // attachment is null by construction.
    res.json({
      post: { ...result.generated, generated_image_id: null }, quality: result.quality, postId: result.postId,
      genre, fidelity: result.generated.fidelity || null,
      publishTarget: result.publishTarget ?? null
    });
  } catch (err) {
    platformLog("error", "compose_generate_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// POST /api/compose/blank
// Blank-canvas / manual authoring path (No genre). Creates an EMPTY draft
// (no AI, no research, no topic) and returns it so the client can open it
// directly in the editor. genre is provenance-only and NOT NULL in the
// schema, so a hand-written post is recorded as 'manual'.
router.post("/blank", requirePermission("preview_post"), async (req, res) => {
  try {
    const post = await withTenant(req.tenant.id, async () => {
      const id = await createPost({
        topicId: null,
        title: "",
        content: "",
        hashtags: [],
        newsContext: null,
        scheduledFor: null,
        imageUrl: null,
        genre: "manual"
      });
      await logActivity("info", "blank_draft_created", { postId: id }, req.user?.sub || null);
      return getPost(id);
    });
    res.json({ post });
  } catch (err) {
    console.error("[compose/blank] failed:", err.message);
    res.status(500).json({ error: "Could not create a blank draft." });
  }
});

// GET /api/compose/topic-metrics?topicId=<slug>
// Metric landscape for a topic: group count and metric count per
// group. Metadata only — verbatim values and citations are a later
// cycle. Drives the composer's compatibility-aware genre menu and the
// group-resolution step.
router.get("/topic-metrics", requirePermission("preview_post"), async (req, res) => {
  try {
    const slug = typeof req.query.topicId === "string" ? req.query.topicId.trim() : "";
    if (!slug) {
      return res.status(400).json({ error: "topicId is required" });
    }

    const landscape = await withTenant(req.tenant.id, async () => {
      const topic = await getTopicBySlug(slug);
      if (!topic) return null;
      const groups = await getMetricsForTopic(topic.id);
      return {
        topicId: topic.slug,
        groupCount: groups.length,
        groups: groups.map(g => ({
          groupSlug: g.groupSlug,
          groupLabel: g.groupLabel,
          metricCount: Array.isArray(g.metrics) ? g.metrics.length : 0
        }))
      };
    });

    if (!landscape) {
      return res.status(404).json({ error: "Topic not found" });
    }
    res.json({ landscape });
  } catch (err) {
    platformLog("error", "compose_topic_metrics_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// GET /api/compose/genres?topicId=<slug>
// The composer's genre menu. Returns each content_generator genre with
// its description and metric_bearing flag, annotated with whether it is
// selectable for the given topic. A metric-bearing genre is selectable
// only when the topic has at least one usable metric; otherwise it is
// returned not-selectable with a reason. topicId is optional — without
// it (auto-select) no topic supplies metrics, so metric-bearing
// genres are not selectable; non-metric genres always are.
// GET /api/compose/model-info - the exact text model a generation
// will use, resolved by the SAME function the pipeline calls
// (resolveTenantLlmSelection), so this label can never drift from
// the truth. Unprovisioned workspaces answer nulls, not errors.
router.get("/model-info", requirePermission("preview_post"), async (req, res) => {
  try {
    const sel = await withTenant(req.tenant.id, () => resolveTenantLlmSelection());
    return res.status(200).json({ provider: sel.provider, model: sel.model });
  } catch {
    return res.status(200).json({ provider: null, model: null });
  }
});

router.get("/genres", requirePermission("preview_post"), async (req, res) => {
  try {
    const slug = typeof req.query.topicId === "string" ? req.query.topicId.trim() : "";

    // Genre catalog is platform-level (not tenant-scoped) — read it
    // outside withTenant. Metadata + flag only, no ciphertext.
    //
    // Two exclusions, both server-side so the picker only ever receives
    // what it should display:
    //   1. the internal refine genre — never a user-facing style (the
    //      platform-admin genre list still shows it for editing); and
    //   2. metric-bearing genres (metric_bearing = true, e.g. 'metricvalue')
    //      — these drive the metric pipeline and are out of scope for the
    //      Create flow, which offers metric-free content styles only.
    // A metric-bearing genre stays valid on the backend (genreExists in
    // /generate accepts it); it is simply not offered here.
    const genres = (await listGenresForKey("content_generator"))
      .filter((g) => g.genre !== INTERNAL_REFINE_GENRE && g.metricBearing !== true);

    let topicHasMetrics = null;
    let resolvedSlug = null;
    if (slug) {
      const probe = await withTenant(req.tenant.id, async () => {
        const topic = await getTopicBySlug(slug);
        if (!topic) return null;
        const groups = await getMetricsForTopic(topic.id);
        return { slug: topic.slug, hasMetrics: groups.length > 0 };
      });
      if (!probe) {
        return res.status(404).json({ error: "Topic not found" });
      }
      topicHasMetrics = probe.hasMetrics;
      resolvedSlug = probe.slug;
    }

    const menu = genres.map((g) => {
      const blockedByMetrics = g.metricBearing && !topicHasMetrics;
      return {
        genre: g.genre,
        description: g.description,
        metricBearing: g.metricBearing,
        selectable: !blockedByMetrics,
        reason: blockedByMetrics ? "Needs a topic with metric data." : null
      };
    });

    res.json({ topicId: resolvedSlug, topicHasMetrics, genres: menu });
  } catch (err) {
    platformLog("error", "compose_genres_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// GET /api/compose/metric-preview?topicId=<slug>&genre=<genre>
// The pre-generation fidelity preview: the verbatim metric values and
// citations that will be locked into the post, exactly as the engine
// resolves them for this topic and genre — surfaced BEFORE the LLM runs
// so the operator can verify them.
//
// "Will these be injected?" is answered authoritatively against the LIVE
// content_generator template (templateUsesMetricBlock) — the same
// template generation reads — not the cached metric_bearing column,
// which can drift. The preview otherwise mirrors generation: the same
// per-topic, enabled-only metrics (getMetricsForTopic under RLS) and the
// same genre→default template fallback inside the vault. It returns
// STRUCTURED data only: never the assembled metric block (its
// instructional header and {{METRIC_key}} token scheme are prompt-
// assembly internals) and never the template plaintext.
router.get("/metric-preview", requirePermission("preview_post"), async (req, res) => {
  try {
    const slug = typeof req.query.topicId === "string" ? req.query.topicId.trim() : "";
    const rawGenre = typeof req.query.genre === "string" ? req.query.genre.trim() : "";
    const genre = rawGenre || "default";

    if (!slug) {
      return res.status(400).json({ error: "topicId is required" });
    }
    if (!GENRE_RE.test(genre)) {
      return res.status(400).json({ error: "Invalid genre format." });
    }
    if (genre !== "default") {
      const exists = await genreExists("content_generator", genre);
      if (!exists) {
        return res.status(400).json({ error: "Unknown genre: " + genre });
      }
    }

    // Tenant-scoped: resolve the topic and load its enabled metrics
    // under RLS — the same reader generation uses, so the preview shows
    // exactly the metrics generation would see.
    const resolved = await withTenant(req.tenant.id, async () => {
      const topic = await getTopicBySlug(slug);
      if (!topic) return null;
      const groups = await getMetricsForTopic(topic.id);
      return { slug: topic.slug, groups };
    });
    if (!resolved) {
      return res.status(404).json({ error: "Topic not found" });
    }

    // Authoritative, platform-level: does the live template for this
    // genre actually inject the block? Boolean only — the template
    // plaintext stays inside the vault module.
    const metricBearing = await templateUsesMetricBlock("content_generator", genre);

    const groups = resolved.groups.map((g) => ({
      groupSlug: g.groupSlug,
      groupLabel: g.groupLabel,
      metrics: (Array.isArray(g.metrics) ? g.metrics : []).map((m) => ({
        metricKey: m.metricKey,
        value: m.value,
        unit: m.unit,
        source: {
          name: m.source ? m.source.name : null,
          quote: m.source ? m.source.quote : null,
          locator: m.source ? m.source.locator : null,
          url: m.source ? m.source.url : null
        }
      }))
    }));
    const metricCount = groups.reduce((n, g) => n + g.metrics.length, 0);
    const willInjectMetrics = metricBearing && metricCount > 0;

    // status drives the operator-facing framing:
    //   ready            — metrics exist and this genre will lock them in
    //   needs_metrics     — genre injects the block but the topic has none
    //                       (the genre menu already disables this pairing;
    //                        surfaced here as defense in depth)
    //   genre_no_metrics  — this genre's template does not use metrics, so
    //                       none are injected regardless of the topic
    let status;
    if (!metricBearing) {
      status = "genre_no_metrics";
    } else if (metricCount === 0) {
      status = "needs_metrics";
    } else {
      status = "ready";
    }

    res.json({
      topicId: resolved.slug,
      genre,
      metricBearing,
      willInjectMetrics,
      status,
      groupCount: groups.length,
      metricCount,
      groups
    });
  } catch (err) {
    platformLog("error", "compose_metric_preview_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

export default router;
