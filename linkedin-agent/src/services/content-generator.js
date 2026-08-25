// ═══════════════════════════════════════════════════════════════
// Content Generation Service — Anthropic Claude integration
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { getLastPostedTopic, getRecentPosts, getAgentState, logActivity, logActivityBestEffort } from "./database.js";
import { platformLog } from "./platform-log.js";
import { frameUntrustedContent } from "./prompt-framing.js";
import { getAnthropicApiKey } from "../tenant/credential-store.js";
import { getAnthropicModel, callAnthropic } from "../config/ai.js";
import { generateWithTenantLlm, isLlmAbstractionEnabled } from "../llm/client.js";

// 2.5.81: the abstraction flag's OFF state is a WHOLE OPERATING
// MODE (legacy direct Anthropic; no key-resolution chain, no trial
// precedence, no spend metering for text) and it must never again
// be silent. One warning per boot, at first legacy use.
let legacyPathWarned = false;
function warnLegacyPathOnce() {
  if (legacyPathWarned) return;
  legacyPathWarned = true;
  platformLog("warn", "llm_abstraction_disabled_legacy_path", {
    detail: "LLM_ABSTRACTION is not '1': text generation runs the legacy direct path. Trial keys and spend metering are INACTIVE for text until the flag is set."
  });
}
import { getPrompt, getAuthorizedPrompt, renderPrompt, genreExists } from "./prompt-vault.js";
import { traceEnabled, buildLlmRequestInfo, buildLlmPayloadDebug } from "./llm-trace.js";
import { buildMetricBlock, substituteMetricTokens, extractNumericTokens, verifyMetricFidelity } from "./metric-content.js";
import { getCooldownMs } from "../config/research.js";
import { generationTrace, generationVendor, traceArguments, promptOverride, corroborationOverride, labRun, spanStart } from "./generation-trace.js";
import { getTopicsForGeneration, getTopicBySlug } from "../tenant/topic-store.js";
import { resolveAngle } from "./angle-select.js";

// Anthropic client is constructed per-call using the tenant's
// BYOK key fetched from the credential store. Module-level
// caching would leak keys across tenants.
async function newAnthropicClient() {
  const apiKey = await getAnthropicApiKey();
  return new Anthropic({ apiKey });
}

// ── Topic Selection ──────────────────────────────────────────

// userSub: null = global topics only (scheduler/automated),
//          string = global + that user's personal topics (manual preview).
export async function selectNextTopic(userSub = null) {
  const lastTopicId = await getLastPostedTopic();
  const recentPosts = await getRecentPosts(14);
  const allTopics = await getTopicsForGeneration(userSub);

  if (allTopics.length === 0) {
    throw new Error("No enabled topics available for content generation");
  }

  const recentCounts = {};
  for (const post of recentPosts) {
    recentCounts[post.topic_id] = (recentCounts[post.topic_id] || 0) + 1;
  }

  // Total weight for normalization
  const totalWeight = allTopics.reduce((sum, t) => sum + (t.weight || 1), 0);

  const candidates = allTopics
    .filter(t => t.slug !== lastTopicId)
    .map(topic => {
      const baseWeight = (topic.weight || 1) / totalWeight;
      const recentCount = recentCounts[topic.slug] || 0;
      const totalRecent = recentPosts.length || 1;
      const expectedShare = baseWeight;
      const actualShare = recentCount / totalRecent;
      const balanceFactor = expectedShare / Math.max(actualShare, 0.05);
      return { topic, weight: baseWeight * Math.min(balanceFactor, 3.0) };
    });

  if (candidates.length === 0) {
    // All topics were filtered (only one topic and it was last posted)
    const fallback = allTopics.map(t => ({
      topic: t,
      weight: (t.weight || 1) / totalWeight
    }));
    return fallback[Math.floor(Math.random() * fallback.length)].topic;
  }

  const candidateTotal = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * candidateTotal;

  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.topic;
  }

  return candidates[candidates.length - 1].topic;
}

// ── Content Angle Selection ──────────────────────────────────

// selectContentAngle moved to ./angle-select.js (delivery 1.8.7)

// ── Post Generation ──────────────────────────────────────────

export async function getTopicByIdFromDb(topicId) {
  return getTopicBySlug(topicId);
}

export async function getAvailableTopics(userSub = null) {
  const topics = await getTopicsForGeneration(userSub);
  return topics.map(t => ({ id: t.slug, name: t.name }));
}

export async function generatePost(topic = null, userSub = null, actionToken = null, requestedAngle = null, genre = "default") {
  traceArguments("generatePost",
    'export async function generatePost(topic = null, userSub = null, actionToken = null, requestedAngle = null, genre = "default")',
    [["topic", topic], ["userSub", userSub], ["actionToken", actionToken],
     ["requestedAngle", requestedAngle], ["genre", genre]]);
  if (typeof topic === "string") {
    topic = await getTopicBySlug(topic);
  }
  if (!topic) topic = await selectNextTopic(userSub);

  const cycleId = crypto.randomBytes(4).toString("hex");

  // Read corroboration toggle from agent state. A Lab run may carry
  // a frame override (4.25111.21): the operator's forced choice
  // rides the frame exactly like a prompt override, is consulted
  // HERE at the one read site, and is never written anywhere. Null
  // frame or no override means the tenant's stored value governs,
  // byte for byte as before.
  const corrOverride = corroborationOverride();
  const skipCorroboration = corrOverride !== null
    ? !corrOverride
    : (await getAgentState("corroboration")) === "disabled";

  // Vault access: use signed token when triggered by a user request,
  // fall back to internal access for automated/scheduled operations.
  const vaultGet = actionToken
    ? (key) => getAuthorizedPrompt(key, actionToken)
    : (key) => getPrompt(key);

  const recentPosts = await getRecentPosts(14);

  // Angle decision (Feature 2): an explicitly requested angle must be
  // an EXISTING member of topic.content_angles; otherwise fail closed.
  // No request -> the pre-existing auto-rotation, unchanged.
  traceArguments("resolveAngle", "export function resolveAngle(topic, requested, recentPosts)",
    [["topic", topic], ["requested", requestedAngle], ["recentPosts", recentPosts]]);
  const angleTook = spanStart();
  const angleResult = resolveAngle(topic, requestedAngle, recentPosts);
  const angleTookMs = angleTook && angleTook();
  if (!angleResult.ok) {
    const reason = angleResult.reason;
    await logActivity("info", "post_blocked_invalid_angle", { cycleId, topicId: topic.slug, reason });
    platformLog("warn", "post_blocked_invalid_angle", { cycleId, topicId: topic.slug, reason });
    return { blocked: true, reason, topicId: topic.slug, angle: null, cycleId };
  }
  const angle = angleResult.angle;
  // Console: the perspective this post will be written from, and
  // whether the user chose it or rotation did.
  platformLog("info", "angle_resolved", {
    cycleId, topicId: topic.slug, angle,
    mode: angleResult.selected ? "user-selected" : "auto-rotated"
  });
  generationTrace()?.stage("angle_resolved", {
    angle, mode: angleResult.selected ? "operator-selected" : "auto-rotated",
    availableAngles: topic.content_angles || [],
    recentPostsConsidered: recentPosts.length
  }, angleTookMs);

  // ── Research phase ─────────────────────────────────────────
  let researchBrief = null;
  try {
    const { conductResearch } = await import("./research.js");
    researchBrief = await conductResearch(topic.slug, angle, cycleId, skipCorroboration, actionToken);

    await logActivity("info", "research_integrated", {
      cycleId,
      topicId: topic.slug,
      corroborationSkipped: skipCorroboration,
      verifiedClaims: researchBrief.verifiedClaimCount,
      independentSources: researchBrief.independentSourceCount,
      totalItems: researchBrief.summary.totalSourceItems,
      hasEnoughMaterial: researchBrief.hasEnoughMaterial
    });
    platformLog("info", "research_integrated", {
      cycleId, topicId: topic.slug,
      verified: researchBrief.verifiedClaimCount,
      sources: researchBrief.independentSourceCount,
      items: researchBrief.summary.totalSourceItems,
      enough: researchBrief.hasEnoughMaterial
    });
  } catch (err) {
    // Best effort: if research failed by ABORTING the tenant
    // transaction, a plain logActivity here would throw 25P02 and
    // this catch would fail the run instead of degrading it.
    await logActivityBestEffort("warn", "research_unavailable", {
      cycleId, topicId: topic.slug, error: err.message
    });
  }

  // ── Block if sources are insufficient ──────────────────────
  if (!researchBrief || !researchBrief.hasEnoughMaterial) {
    const reason = !researchBrief
      ? "Research service unavailable"
      : skipCorroboration
        ? `Only ${researchBrief.independentSourceCount} independent source(s) found; minimum is 2`
        : `Only ${researchBrief.verifiedClaimCount || 0} verified claim(s) found; minimum is 1 from 2+ independent sources`;

    await logActivity("info", "post_blocked_insufficient_sources", {
      cycleId, topicId: topic.slug, angle, reason
    });
    platformLog("warn", "post_blocked_insufficient_sources", {
      cycleId, topicId: topic.slug, reason
    });

    return { blocked: true, reason, topicId: topic.slug, angle, cycleId };
  }

  // ── Rate limit cooldown before generation ──────────────────
  // Paces real Model Provider traffic on a tenant's key only. A
  // substituted call waits for nothing, and a Lab run (4.25111.21,
  // the same delegated ruling as the corroboration cooldown in
  // research.js) is an interactive one-off on the separate platform
  // key: this pause only lengthened the Lab's held transaction.
  const cooldown = (labRun() || generationVendor()) ? 0 : getCooldownMs();
  await logActivity("info", "rate_limit_cooldown", { cycleId, message: `Waiting ${cooldown / 1000}s before content generation` });
  if (cooldown > 0) await new Promise(resolve => setTimeout(resolve, cooldown));

  // Build context about what was recently posted to avoid repetition
  const recentSummaries = recentPosts.slice(0, 6).map(p =>
    `- [${p.topic_id}] "${p.title}"`
  ).join("\n");

  // ── Research context: rules differ based on corroboration toggle ──
  let researchBlock;
  // Measured: the framing wrap plus the vault read and render below,
  // which is everything the researchBlock row represents.
  const rbTook = spanStart();
  const framedContext = await frameUntrustedContent(researchBrief.context, actionToken);

  if (!skipCorroboration) {
    let rbTemplate = await vaultGet("research_brief_corroborated");
    if (!rbTemplate) {
      platformLog("error", "prompt_vault_miss", { key: "research_brief_corroborated" });
      throw new Error("Research brief prompt (corroborated) not configured");
    }
    researchBlock = renderPrompt(rbTemplate, {
      RESEARCH_CONTEXT: framedContext
    });
    rbTemplate = null;
  } else {
    let rbTemplate = await vaultGet("research_brief_uncorroborated");
    if (!rbTemplate) {
      platformLog("error", "prompt_vault_miss", { key: "research_brief_uncorroborated" });
      throw new Error("Research brief prompt (uncorroborated) not configured");
    }
    researchBlock = renderPrompt(rbTemplate, {
      RESEARCH_CONTEXT: framedContext,
      SOURCE_COUNT: String(researchBrief.independentSourceCount)
    });
    rbTemplate = null;
  }

  // vars is rebuilt to match the branch that ACTUALLY ran. The
  // corroborated path passes RESEARCH_CONTEXT alone, so listing a
  // SOURCE_COUNT key there would report a parameter that was never
  // supplied.
  const rbVars = skipCorroboration
    ? { RESEARCH_CONTEXT: framedContext, SOURCE_COUNT: String(researchBrief.independentSourceCount) }
    : { RESEARCH_CONTEXT: framedContext };
  traceArguments("researchBlock", "export function renderPrompt(template, vars)",
    [["template", "research_brief_" + (!skipCorroboration ? "corroborated" : "uncorroborated") + " (from the vault)"],
     ["vars", rbVars]],
    "This row is a template render inside generatePost, not a pipeline call of its own.");
  generationTrace()?.stage("research_block", {
    corroborated: !skipCorroboration,
    promptKey: !skipCorroboration ? "research_brief_corroborated" : "research_brief_uncorroborated",
    renderedBlock: researchBlock
  }, rbTook && rbTook());

  const topicHashtags = topic.hashtags || [];

  // ── Verified metrics (METRICS FIDELITY) ────────────────────
  // Pull the topic's verified metrics so the model can cite them via
  // {{METRIC_key}} tokens that are substituted with exact values
  // after generation. Guarded: a missing tenant context, absent
  // topic id, or fetch error degrades to research-only generation —
  // it must never break the existing path.
  const metricTook = spanStart();
  let metricGroups = [];
  const metricsByKey = new Map();
  try {
    if (topic.id !== null && topic.id !== undefined) {
      const { getMetricsForTopic } = await import("./metric-store.js");
      metricGroups = await getMetricsForTopic(topic.id);
      for (const grp of metricGroups) {
        for (const mt of grp.metrics) metricsByKey.set(mt.metricKey, mt);
      }
    }
  } catch (err) {
    platformLog("warn", "metric_fetch_failed", { cycleId, topicId: topic.slug, error: err.message });
    metricGroups = [];
    metricsByKey.clear();
  }
  traceArguments("metricBlock", "export function buildMetricBlock(groups)",
    [["groups", metricGroups]]);
  const metricBlock = buildMetricBlock(metricGroups);
  // Database material assembled for generation, alongside the block
  // it becomes. An empty block with metrics present means the genre
  // template carries no {{METRIC_BLOCK}} placeholder.
  generationTrace()?.stage("metric_block", {
    metricGroups: metricGroups.length,
    metricsAvailable: metricsByKey.size,
    metricKeys: [...metricsByKey.keys()],
    renderedBlock: metricBlock
  }, metricTook && metricTook());
  platformLog("info", "metrics_loaded", { cycleId, topicId: topic.slug, groups: metricGroups.length, metrics: metricsByKey.size });

  // Genre applies ONLY to the content_generator template — never to
  // the research, verification, or injection-defense prompts (they
  // stay genre-invariant via vaultGet's default). A missing genre row
  // falls back to 'default' inside the vault, so this can never fail
  // generation for an unknown genre.
  let cgTemplate = actionToken
    ? await getAuthorizedPrompt("content_generator", actionToken, genre)
    : await getPrompt("content_generator", genre);
  if (!cgTemplate) {
    platformLog("error", "prompt_vault_miss", { key: "content_generator" });
    throw new Error("Content generation prompt not configured");
  }
  // Applied AFTER the vault read, so it replaces whichever row served,
  // including a genre that fell back to default. Null in production,
  // where no frame is ambient. The trace records the substitution so a
  // run can never claim it generated from vault text when it did not.
  const cgOverride = promptOverride("content_generator");
  if (cgOverride) {
    generationTrace()?.stage("prompt_override", {
      key: "content_generator",
      resolvedGenre: genre,
      vaultChars: cgTemplate.length,
      overrideChars: cgOverride.length,
      vaultPlaceholders: [...new Set(cgTemplate.match(/{{[A-Z_]+}}/g) || [])],
      overridePlaceholders: [...new Set(cgOverride.match(/{{[A-Z_]+}}/g) || [])]
    });
    cgTemplate = cgOverride;
  }
  let userPrompt = renderPrompt(cgTemplate, {
    TOPIC_NAME: topic.name,
    ANGLE: angle,
    RESEARCH_BLOCK: researchBlock,
    METRIC_BLOCK: metricBlock,
    RECENT_SUMMARIES: recentSummaries || "(no recent posts)",
    ATTESTATION_RULE: !skipCorroboration ? "\n10. Include the attestation line after the Sources line." : "",
    ATTESTATION_BODY: !skipCorroboration ? " and attestation line" : ""
  });
  cgTemplate = null;

  await logActivity("info", "content_generation_started", { cycleId, topicId: topic.slug, angle });
  platformLog("info", "content_generation_started", { cycleId, topicId: topic.slug, angle });

  const genStartMs = Date.now();

  try {
    // Model Provider call. Flag ON (LLM_ABSTRACTION=1): the orchestrator
    // resolves the tenant's provider + model, enforces the egress
    // allowlist, and returns the canonical response, so this
    // pipeline never learns which Model Provider served the request.
    // Flag OFF (default): the pre-existing direct Anthropic path,
    // byte-for-byte unchanged.
    traceArguments("generateContent",
      "export async function generateWithTenantLlm(input, deps = {})",
      [["input", { system: topic.system_context || null, user: userPrompt,
                   maxOutputTokens: 1500, purpose: "main_post_generation", cycleId }],
       ["deps", "(omitted, defaults)"]]);
    generationTrace()?.stage("generation_request", {
      genre,
      systemContext: topic.system_context || null,
      maxOutputTokens: 1500,
      assembledPrompt: userPrompt
    });
    let generatedText;
    let generationModel;
    let genProviderMeta = null;
    let genProviderTookMs;
    const genSubstitute = generationVendor();
    if (genSubstitute) {
      // Substituted Model Provider. The prompt above is exactly what a real
      // call would have carried; parsing, metric substitution and the
      // fidelity gate below all run unchanged.
      const mocked = genSubstitute.orchestrated("main_post_generation");
      generatedText = mocked.text;
      generationModel = `${mocked.provider}/${mocked.model}`;
    } else if (isLlmAbstractionEnabled()) {
      const orchestrated = await generateWithTenantLlm({
        system: topic.system_context || null,
        user: userPrompt,
        maxOutputTokens: 1500,
        temperature: null,
        stopSequences: null,
        purpose: "main_post_generation",
        cycleId
      });
      generatedText = orchestrated.text;
      generationModel = `${orchestrated.provider}/${orchestrated.model}`;
      // The orchestrator returns usage, stop reason and a cost
      // estimate alongside the text. The pipeline needs only the text,
      // so an observer has to take the rest here or it is lost.
      genProviderMeta = {
        usage: orchestrated.usage || null,
        stopReason: orchestrated.stopReason || null,
        costEstimateUsd: typeof orchestrated.costEstimateUsd === "number" ? orchestrated.costEstimateUsd : null
      };
      // The orchestrator measures its own Model Provider call; report that
      // number rather than measuring the same interval a second time.
      genProviderTookMs = typeof orchestrated.durationMs === "number" ? orchestrated.durationMs : undefined;
    } else {
      warnLegacyPathOnce();
      const client = await newAnthropicClient();
      const model = await getAnthropicModel();
      const requestParams = {
        model,
        max_tokens: 1500,
        system: topic.system_context || undefined,
        messages: [{ role: "user", content: userPrompt }]
      };
      platformLog("info", "llm_request_main_post_generation",
        buildLlmRequestInfo("main_post_generation", "3 of 4", requestParams,
          { cycleId, topicId: topic.slug, angle, corroborationSkipped: skipCorroboration }));
      if (traceEnabled(process.env.LLM_TRACE)) {
        platformLog("debug", "llm_payload_main_post_generation",
          buildLlmPayloadDebug("main_post_generation", requestParams, cycleId));
      }
      const response = await callAnthropic(client, requestParams);
      generatedText = response.content[0].text;
      generationModel = model;
    }
    userPrompt = null;

    generationTrace()?.stage("generation_response", Object.assign({
      model: generationModel, rawText: generatedText
    }, genProviderMeta || {}), genProviderTookMs);

    const raw = generatedText.trim();
    const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    // ── Metric tokenization + fidelity verification ────────────
    // Substitute {{METRIC_key}} with exact verified values, then
    // verify. Token integrity always blocks (an unknown token would
    // otherwise print literally / a fabricated metric reference).
    // Strict number-policing (every number must be a verified metric
    // or appear in the research) is OPT-IN via METRIC_FIDELITY_STRICT,
    // because on-by-default it would block research-driven posts whose
    // legitimate numbers (years, counts, cited stats) are not metrics.
    const strictFidelity = (process.env.METRIC_FIDELITY_STRICT || "").trim() === "1";
    const sub = substituteMetricTokens(parsed.body, metricsByKey);
    const allowedNumbers = strictFidelity ? extractNumericTokens(researchBlock) : [];
    traceArguments("fidelity", "export function verifyMetricFidelity(text, byKey, options)",
      [["text", sub.text], ["byKey", metricsByKey],
       ["options", { strict: strictFidelity, allowedNumbers }]]);
    const fidelityTook = spanStart();
    const fidelity = verifyMetricFidelity(sub.text, metricsByKey, { strict: strictFidelity, allowedNumbers });
    const fidelityTookMs = fidelityTook && fidelityTook();
    if (!fidelity.ok) {
      const reason = fidelity.unknownTokens.length
        ? "Unknown metric token(s): " + fidelity.unknownTokens.join(", ")
        : "Unverified number(s) not traceable to a metric or the research: " + fidelity.unverifiedNumbers.join(", ");
      await logActivity("warn", "metric_fidelity_violation", { cycleId, topicId: topic.slug, reason });
      platformLog("warn", "metric_fidelity_violation", {
        cycleId, topicId: topic.slug,
        unknownTokens: fidelity.unknownTokens, unverifiedNumbers: fidelity.unverifiedNumbers, strict: strictFidelity
      });
      return { blocked: true, reason: "Metric fidelity check failed. " + reason, topicId: topic.slug, angle, cycleId,
        fidelity: {
          verified: false,
          strict: strictFidelity,
          unknownTokens: fidelity.unknownTokens,
          unverifiedNumbers: fidelity.unverifiedNumbers
        } };
    }
    generationTrace()?.stage("fidelity", {
      strict: strictFidelity,
      verified: fidelity.ok,
      metricTokensSubstituted: sub.substituted,
      unknownTokens: fidelity.unknownTokens,
      unverifiedNumbers: fidelity.unverifiedNumbers
    }, fidelityTookMs);
    parsed.body = sub.text;
    if (sub.substituted.length) {
      platformLog("info", "metric_tokens_substituted", { cycleId, topicId: topic.slug, count: sub.substituted.length, keys: sub.substituted });
    }

    const allHashtags = [...new Set([
      ...parsed.hashtags,
      ...topicHashtags
    ])].slice(0, 6);

    const genDurationMs = Date.now() - genStartMs;
    const genSuccessDetails = {
      cycleId,
      topicId: topic.slug,
      model: generationModel,
      title: parsed.title,
      wordCount: parsed.body.split(/\s+/).length,
      sourcesUsed: (parsed.sources_used || []).length,
      durationMs: genDurationMs
    };

    await logActivity("info", "content_generation_success", genSuccessDetails);
    platformLog("info", "content_generation_success", genSuccessDetails);

    return {
      cycleId,
      topicId: topic.slug,
      genre,
      title: parsed.title,
      content: parsed.body,
      hashtags: allHashtags,
      angle,
      sourcesUsed: parsed.sources_used || [],
      articleImages: researchBrief.articleImages || [],
      researchSummary: {
        verifiedClaims: researchBrief.verifiedClaimCount,
        independentSources: researchBrief.independentSourceCount,
        totalSourceItems: researchBrief.summary.totalSourceItems,
        corroborationSkipped: skipCorroboration,
        sourceList: researchBrief.sourceList || []
      },
      fidelity: {
        verified: true,
        strict: strictFidelity,
        usedMetricKeys: sub.substituted,
        metricsAvailable: metricsByKey.size
      }
    };
  } catch (err) {
    // Best effort: this catch RETHROWS the original error below. A
    // plain logActivity on an aborted transaction would throw 25P02
    // first and the caller would see the logging failure instead of
    // the real cause.
    await logActivityBestEffort("error", "content_generation_failed", {
      cycleId, topicId: topic.slug, error: err.message
    });
    platformLog("error", "content_generation_failed", {
      cycleId, topicId: topic.slug, error: err.message,
      code: err.code, status: err.status, type: err.constructor?.name,
      stack: (err.stack || "").split("\n").slice(0, 3).join(" | ")
    });
    throw err;
  }
}

// ── Content Quality Check ────────────────────────────────────

export async function qualityCheck(content, researchSummary = null, cycleId = null, actionToken = null) {
  traceArguments("qualityCheck",
    "export async function qualityCheck(content, researchSummary = null, cycleId = null, actionToken = null)",
    [["content", content], ["researchSummary", researchSummary],
     ["cycleId", cycleId], ["actionToken", actionToken]]);
  // Grounding context has two honest shapes:
  //   object -> the org research brief (original behavior, byte
  //             identical for the org pipeline), or
  //   string -> DERIVATIVE grounding: the finished source text the
  //             reviewed post adapts (advocacy variants). Every
  //             claim in the reviewed post must trace to it, and
  //             today's date is stated so legitimately dated
  //             material is never mistaken for future-dated
  //             fabrication by a reviewer with an older clock.
  const sourceContext = typeof researchSummary === "string" && researchSummary.trim().length > 0
    ? `\nTODAY'S DATE: ${new Date().toISOString().slice(0, 10)}\nGROUND TRUTH FOR THIS DERIVATIVE POST (the finished organization post it adapts). Every claim, number, attribution, and source in the reviewed post must be traceable to this text. Treat dates appearing here as valid even if they postdate your training data:\n${researchSummary.trim()}`
    : researchSummary
    ? `\nSOURCES PROVIDED TO THE WRITER:\n${researchSummary.sourceList?.map(s => `- ${s.name} (${s.tier})`).join("\n") || "(none)"}\nVerified claims (corroborated by 2+ sources): ${researchSummary.verifiedClaims || 0}\nIndependent sources consulted: ${researchSummary.independentSources || 0}\nCorroboration step: ${researchSummary.corroborationSkipped ? 'SKIPPED' : 'COMPLETED'}`
    : "\n(No research brief was provided — post should avoid specific factual claims)";

  const qVaultGet = actionToken
    ? (key) => getAuthorizedPrompt(key, actionToken)
    : (key) => getPrompt(key);

  // Retrieve prompt template from encrypted vault
  let template = await qVaultGet("quality_reviewer");
  if (!template) {
    platformLog("error", "prompt_vault_miss", { key: "quality_reviewer" });
    return null;
  }
  let assembledPrompt = renderPrompt(template, {
    CONTENT: content,
    SOURCE_CONTEXT: sourceContext
  });
  template = null;

  // Model Provider call: orchestrated when LLM_ABSTRACTION=1, otherwise
  // the pre-existing direct Anthropic path, unchanged.
  generationTrace()?.stage("quality_request", {
    maxOutputTokens: 800, assembledPrompt
  });
  let reviewText;
  let qProviderMeta = null;
  let qProviderTookMs;
  const qSubstitute = generationVendor();
  if (qSubstitute) {
    reviewText = qSubstitute.orchestrated("quality_check").text;
  } else if (isLlmAbstractionEnabled()) {
    const orchestrated = await generateWithTenantLlm({
      system: null,
      user: assembledPrompt,
      maxOutputTokens: 800,
      temperature: null,
      stopSequences: null,
      purpose: "quality_check",
      cycleId: cycleId || null
    });
    reviewText = orchestrated.text;
    qProviderMeta = {
      model: `${orchestrated.provider}/${orchestrated.model}`,
      usage: orchestrated.usage || null,
      stopReason: orchestrated.stopReason || null,
      costEstimateUsd: typeof orchestrated.costEstimateUsd === "number" ? orchestrated.costEstimateUsd : null
    };
    qProviderTookMs = typeof orchestrated.durationMs === "number" ? orchestrated.durationMs : undefined;
  } else {
    warnLegacyPathOnce();
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();
    const requestParams = {
      model,
      max_tokens: 800,
      messages: [{ role: "user", content: assembledPrompt }]
    };
    platformLog("info", "llm_request_quality_check",
      buildLlmRequestInfo("quality_check", "4 of 4", requestParams, { cycleId }));
    if (traceEnabled(process.env.LLM_TRACE)) {
      platformLog("debug", "llm_payload_quality_check",
        buildLlmPayloadDebug("quality_check", requestParams, cycleId));
    }
    const response = await callAnthropic(client, requestParams);
    reviewText = response.content[0].text;
  }
  assembledPrompt = null;

  generationTrace()?.stage("quality_response",
    Object.assign({ rawText: reviewText }, qProviderMeta || {}), qProviderTookMs);

  const raw = reviewText.trim();
  const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

// ── Refine an existing draft ─────────────────────────────────
// One-pass polish of an already-generated post. Does NOT re-run research
// or touch the metric apparatus (no METRIC_BLOCK, no tokenization, no
// fidelity gate) — it sharpens the wording of content the user already
// has. The post's existing copy is the input; topic, angle, genre, and a
// source list (from the stored research) are context so the voice holds
// and facts aren't dropped or invented.
//
// The template is the content_generator prompt's 'refine' genre variant.
// CRITICAL fail-closed step: the vault silently falls back to the default
// (GENERATION) template for a missing genre, which would regenerate from
// scratch instead of refining. So existence is checked first and the call
// throws REFINE_NOT_CONFIGURED rather than running the wrong prompt.
export async function refinePost(
  { topicName, angle, genre, title, content, hashtags, sourceContext },
  userSub = null,
  actionToken = null
) {
  const cycleId = crypto.randomBytes(4).toString("hex");

  const configured = await genreExists("content_generator", "refine");
  if (!configured) {
    platformLog("error", "refine_prompt_missing", { cycleId });
    const e = new Error("Refine prompt is not configured (content_generator/refine genre missing).");
    e.code = "REFINE_NOT_CONFIGURED";
    throw e;
  }

  let template = actionToken
    ? await getAuthorizedPrompt("content_generator", actionToken, "refine")
    : await getPrompt("content_generator", "refine");
  if (!template) {
    platformLog("error", "refine_prompt_load_failed", { cycleId });
    const e = new Error("Refine prompt could not be loaded.");
    e.code = "REFINE_NOT_CONFIGURED";
    throw e;
  }

  let userPrompt = renderPrompt(template, {
    TOPIC_NAME: topicName || "",
    ANGLE: angle || "",
    GENRE: genre || "default",
    CURRENT_TITLE: title || "",
    CURRENT_BODY: content || "",
    CURRENT_HASHTAGS: (Array.isArray(hashtags) ? hashtags : []).join(" "),
    SOURCE_CONTEXT: sourceContext || "(no source list recorded)"
  });
  template = null;

  await logActivity("info", "post_refine_started", { cycleId, genre: genre || "default" });
  platformLog("info", "post_refine_started", { cycleId, genre: genre || "default" });

  try {
    // Model Provider call: orchestrated when LLM_ABSTRACTION=1, otherwise
    // the pre-existing direct Anthropic path, unchanged.
    let refinedText;
    if (isLlmAbstractionEnabled()) {
      const orchestrated = await generateWithTenantLlm({
        system: null,
        user: userPrompt,
        maxOutputTokens: 1500,
        temperature: null,
        stopSequences: null,
        purpose: "refine",
        cycleId
      });
      refinedText = orchestrated.text;
    } else {
      warnLegacyPathOnce();
      const client = await newAnthropicClient();
      const model = await getAnthropicModel();
      const requestParams = {
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: userPrompt }]
      };
      platformLog("info", "llm_request_refine",
        buildLlmRequestInfo("refine", "1 of 1", requestParams, { cycleId, genre: genre || "default" }));
      if (traceEnabled(process.env.LLM_TRACE)) {
        platformLog("debug", "llm_payload_refine",
          buildLlmPayloadDebug("refine", requestParams, cycleId));
      }
      const response = await callAnthropic(client, requestParams);
      refinedText = response.content[0].text;
    }
    userPrompt = null;

    const raw = refinedText.trim();
    const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    // Keep the post's hashtags if the model returned none, and cap at 6
    // as generation does.
    const refinedHashtags = Array.isArray(parsed.hashtags) && parsed.hashtags.length
      ? parsed.hashtags.slice(0, 6)
      : (Array.isArray(hashtags) ? hashtags : []);

    platformLog("info", "post_refine_success", { cycleId, wordCount: (parsed.body || "").split(/\s+/).length });
    return { cycleId, title: parsed.title, content: parsed.body, hashtags: refinedHashtags };
  } catch (err) {
    platformLog("error", "post_refine_failed", { cycleId, error: err.message });
    throw err;
  }
}
