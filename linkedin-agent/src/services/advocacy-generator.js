// =================================================================
// src/services/advocacy-generator.js, variant generation (FR-P2-03)
// =================================================================
// Turns one organizational post into per-member personalized
// variants. Same safety posture as org content, gates in order:
//   1. sanitize            inputs normalized; empty source refuses
//   2. injection_framing   detectPromptInjection over EVERY
//                          untrusted input (source content, voice
//                          notes, headline, name) BEFORE any LLM
//   3. output_filter       runOutputFilter over the LLM text
//   4. quality             the house quality reviewer; approved
//                          must be exactly true (fail closed)
// A variant failing any gate is recorded as status 'failed' with
// the gate NAMED in the quality column; it never enters a queue.
//
// The prompt template lives ONLY in the vault (key
// advocacy_variant, read via getAuthorizedPrompt behind the
// "advocacy-variant" action token); no template text in code.
// The LLM call goes through generateWithTenantLlm exclusively.
//
// sanitizeSummary caps at 1000 chars, right for voice notes and
// headlines but too short for post bodies, so source content uses
// the local long-text sanitizer below (same normalization, 5000
// cap). Documented deviation, not a new gate.
//
// Import-safe: everything DB- or LLM-touching loads lazily or
// arrives via deps.
// =================================================================

import { getAdvocacyMaxHashtags } from "../config/advocacy.js";

export const VARIANT_GATES = Object.freeze(["sanitize", "injection_framing", "output_filter", "quality"]);
const SOURCE_CONTENT_CAP = 5000;
const LLM_MAX_OUTPUT_TOKENS = 1200;

// Local long-text sanitizer: control chars out, whitespace
// normalized per line, hard cap. Pure.
export function sanitizeLongText(raw, cap = SOURCE_CONTENT_CAP) {
  if (raw == null) return "";
  let text = String(raw);
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  text = text.replace(/[ \t]+/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
  return text.slice(0, cap);
}

export function mapPostHashtags(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h) => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.trim()).slice(0, getAdvocacyMaxHashtags());
}

// -- Single-variant core (fully deps-injectable) -----------------
// input: { sourcePost: {content, title, hashtags}, member:
// {member_name, member_headline, voice_notes}, topic, actionToken }
// Returns one of:
//   { notConfigured: true }
//   { status: "failed", failedGate, reason }
//   { status: "pending_approval", content, hashtags, quality }
export async function generateAdvocacyVariant(input, deps = {}) {
  const d = { ...deps };
  if (!d.sanitizeShort || !d.detectInjection) {
    const sc = await import("./sanitize-content.js");
    d.sanitizeShort = d.sanitizeShort || sc.sanitizeSummary;
    d.detectInjection = d.detectInjection || sc.detectPromptInjection;
  }
  if (!d.getPrompt || !d.render) {
    const pv = await import("./prompt-vault.js");
    d.getPrompt = d.getPrompt || pv.getAuthorizedPrompt;
    d.render = d.render || pv.renderPrompt;
  }
  if (!d.llm) {
    const { generateWithTenantLlm } = await import("../llm/client.js");
    d.llm = generateWithTenantLlm;
  }
  if (!d.outputFilter) {
    const { runOutputFilter } = await import("./output-filter.js");
    d.outputFilter = runOutputFilter;
  }
  if (!d.quality) {
    const { qualityCheck } = await import("./content-generator.js");
    d.quality = qualityCheck;
  }

  const { sourcePost, member, topic, actionToken } = input || {};

  // Gate 1: sanitize.
  const sourceContent = sanitizeLongText(sourcePost?.content);
  if (!sourceContent) {
    return { status: "failed", failedGate: "sanitize", reason: "source post has no usable content" };
  }
  const memberName = d.sanitizeShort(member?.member_name);
  const memberHeadline = d.sanitizeShort(member?.member_headline);
  const voiceNotes = d.sanitizeShort(member?.voice_notes);
  const topicText = d.sanitizeShort(topic);

  // Gate 2: injection framing. Every untrusted input is screened
  // BEFORE any of it reaches a prompt; the LLM is never invoked
  // past a detection.
  for (const [label, value] of [["source_content", sourceContent], ["voice_notes", voiceNotes],
    ["member_headline", memberHeadline], ["member_name", memberName]]) {
    const verdict = d.detectInjection(value);
    if (verdict.detected) {
      return {
        status: "failed", failedGate: "injection_framing",
        reason: `prompt injection pattern in ${label}: ${verdict.patterns.slice(0, 2).join(", ")}`
      };
    }
  }

  // Prompt: vault-only.
  const template = await d.getPrompt("advocacy_variant", actionToken);
  if (!template) return { notConfigured: true };
  const userPrompt = d.render(template, {
    MEMBER_NAME: memberName || "the member",
    MEMBER_HEADLINE: memberHeadline || "not provided",
    VOICE_NOTES: voiceNotes || "none",
    SOURCE_CONTENT: sourceContent,
    TOPIC: topicText || "not provided"
  });

  const result = await d.llm({
    system: null,
    user: userPrompt,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    temperature: null,
    purpose: "advocacy-variant"
  });
  const text = (result?.text || "").trim();
  if (!text) {
    return { status: "failed", failedGate: "output_filter", reason: "empty model output" };
  }

  // Gate 3: output filter.
  const filter = d.outputFilter(text);
  if (filter.blocked) {
    return { status: "failed", failedGate: "output_filter", reason: filter.reason };
  }

  // Gate 4: quality, on the HOUSE verdict shape the scheduler
  // consumes: { pass, overall, scores, feedback, factual_flags }.
  // pass must be exactly true AND overall must clear the same
  // threshold the org pipeline applies (>= 6); anything else,
  // including a missing or drifted field, fails closed.
  let quality;
  try {
    // The variant's ground truth is the SANITIZED source content
    // itself, passed as the string-typed derivative grounding so
    // the reviewer verifies faithfulness instead of reviewing
    // blind (the 2.2.3 wiring passed only the title, which the
    // reviewer honestly read as "no sources provided").
    quality = await d.quality(text, sourceContent, null, actionToken);
  } catch (err) {
    return { status: "failed", failedGate: "quality", reason: `quality review failed: ${err.message}` };
  }
  const overall = typeof quality?.overall === "number" ? quality.overall : null;
  if (!quality || quality.pass !== true || overall === null || overall < 6) {
    return {
      status: "failed", failedGate: "quality",
      reason: quality?.feedback
        || (quality?.pass !== true ? "reviewer did not pass the content" : `overall score ${overall} below threshold 6`),
      quality
    };
  }

  return {
    status: "pending_approval",
    content: text,
    hashtags: mapPostHashtags(sourcePost?.hashtags),
    quality
  };
}

// -- Fan-out orchestrator (runs INSIDE withTenant) ----------------
// Loads the source post and every CONNECTED member, generates one
// variant per member with per-member failure isolation, and
// persists every outcome (pending or failed-with-gate). Owner-only
// at the route (manage_advocacy); the action token authorizes the
// vault reads down the chain.
export async function generateVariantsForPost(postId, actionToken, requestedBy) {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("variant generation requires tenant context");

  const id = Number.parseInt(String(postId), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: "rejected", reason: "postId must be a positive integer" };
  }
  // Eligibility is enforced HERE, not only in the dropdown
  // (decision 2026-07-09): only a PUBLISHED ORGANIZATION post can
  // seed member variants. Fail-closed for drafts, pending posts,
  // and personal-profile posts regardless of what the caller sends.
  const post = await c.query(
    `SELECT p.id, p.title, p.content, p.hashtags, t.name AS topic_name
       FROM posts p LEFT JOIN topics t ON t.tenant_id = p.tenant_id AND t.id = p.topic_id
      WHERE p.id = $1
        AND p.status = 'posted'
        AND p.publish_target = 'organization'
        AND p.linkedin_id IS NOT NULL`,
    [id]
  );
  if (post.rows.length === 0) {
    return { status: "rejected", reason: "no published organization post with that id in this workspace" };
  }
  const source = post.rows[0];
  const sourcePost = {
    content: source.content,
    title: source.title,
    hashtags: Array.isArray(source.hashtags) ? source.hashtags : []
  };

  const members = await c.query(
    `SELECT auth_sub, member_name, member_headline, voice_notes, mode
       FROM advocacy_members
      WHERE connected = true
      ORDER BY enabled_at ASC`
  );
  if (members.rows.length === 0) {
    return { status: "no_members", generated: 0, failed: 0 };
  }

  let generated = 0;
  let failed = 0;
  let notConfigured = false;
  for (const m of members.rows) {
    try {
      const out = await generateAdvocacyVariant(
        { sourcePost, member: m, topic: source.topic_name, actionToken }
      );
      if (out.notConfigured) { notConfigured = true; break; }
      const isPending = out.status === "pending_approval";
      const inserted = await c.query(
        `INSERT INTO advocacy_variants
           (tenant_id, member_sub, source_post_id, content, hashtags, status, quality)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          m.auth_sub, id,
          isPending ? out.content : "",
          isPending ? out.hashtags : [],
          isPending ? "pending_approval" : "failed",
          JSON.stringify(isPending ? (out.quality || null)
            : { failedGate: out.failedGate, reason: out.reason, reviewer: out.quality || null })
        ]
      );
      if (isPending) generated++; else failed++;

      // Auto mode (TD-5): the member opted in themselves; publish
      // the fresh variant immediately, subject to the per-member
      // caps. Failure or capping never breaks the fan-out; a
      // capped variant simply stays in the manual queue.
      if (isPending && m.mode === "auto") {
        try {
          const { maybeAutoPublish } = await import("./advocacy-publisher.js");
          await maybeAutoPublish(inserted.rows[0].id, m.auth_sub);
        } catch (autoErr) {
          const { platformLog } = await import("./platform-log.js");
          platformLog("warn", "advocacy_auto_publish_failed", { error: autoErr.message });
        }
      }
    } catch (err) {
      failed++;
      const { platformLog } = await import("./platform-log.js");
      platformLog("warn", "advocacy_variant_generation_failed", {
        memberScopedError: err.message
      });
    }
  }

  if (notConfigured) {
    return { status: "prompt_not_configured", generated, failed };
  }
  const { logActivity } = await import("./database.js");
  await logActivity("info", "advocacy_variants_generated", {
    postId: id, members: members.rows.length, generated, failed
  }, requestedBy || null);
  return { status: "generated", members: members.rows.length, generated, failed };
}
