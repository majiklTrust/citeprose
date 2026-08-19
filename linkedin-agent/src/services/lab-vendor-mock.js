// =================================================================
// src/services/lab-vendor-mock.js - the Generation Lab's stand in
// =================================================================
// A substitute for the vendor call, used by Generation Lab runs so
// the pipeline can be exercised end to end without spending money
// or waiting on a model.
//
// DESIGN RULE: the mock reads its own assembled prompt, the same
// input a real model would receive, and answers in the vendor's
// exact response shape. It is not handed the pipeline's internal
// state. This matters because it means every parser, every JSON
// extraction regex, every scoring rule and every gate above the
// wire runs for real against the mock's output. A response the mock
// produces that the pipeline cannot parse is a genuine finding, not
// a mock defect.
//
// The output is DETERMINISTIC. The same run produces the same text,
// so two runs differ only where the pipeline differs.
//
// Deliberate content choices, each with a reason:
//
//   Claims carry three distinct source names across two trust tiers.
//   assembleAllSources classifies by name, and corroboration needs a
//   cumulative trust weight of 3 (feeds.js SOURCE_RULES) before a
//   claim counts as verified. Two primary sources reach exactly 3.
//   Fewer, and every Lab run would block on insufficient sources and
//   the later stages would never be reachable.
//
//   The generated post body contains NO DIGITS. When
//   METRIC_FIDELITY_STRICT is on, every number in a post must trace
//   to a verified metric or appear in the research block. A mock
//   body with an incidental number would fail that gate for reasons
//   that have nothing to do with the pipeline under inspection.
//
//   Nothing the mock writes claims to be true. Source names are real
//   organizations because tier classification keys off them, but
//   every claim is visibly placeholder text.
// =================================================================

const MOCK_MARK = "[generation lab mock]";

// Pull the numbered, quoted queries back out of the research prompt.
// The research stage renders them as: 1. "some query"
function extractQueries(prompt) {
  const out = [];
  const re = /^\s*\d+\.\s*"([^"]+)"/gm;
  let m;
  while ((m = re.exec(String(prompt || ""))) !== null) out.push(m[1]);
  return out;
}

// Count the numbered source entries in the corroboration prompt,
// rendered as: [1] Name (tier, date): text
function countSources(prompt) {
  const matches = String(prompt || "").match(/^\s*\[\d+\]\s/gm);
  return matches ? matches.length : 0;
}

function claimsFor(queries) {
  const subjects = queries.length ? queries : ["the requested topic"];
  const rows = [
    { name: "CISA", url: "https://www.cisa.gov/", date: "2026-08-14", confidence: "high" },
    { name: "Reuters", url: "https://www.reuters.com/", date: "2026-08-13", confidence: "high" },
    { name: "The Record", url: "https://therecord.media/", date: "2026-08-12", confidence: "medium" }
  ];
  return rows.map((row, i) => ({
    claim: `${MOCK_MARK} Placeholder finding for "${subjects[i % subjects.length]}". No real reporting stands behind this sentence.`,
    source_name: row.name,
    source_url: row.url,
    source_date: row.date,
    confidence: row.confidence
  }));
}

// The corroborated verdict. Indices are 1 based into the source list
// the prompt itself presented, so the pipeline's index lookup is
// exercised rather than bypassed.
function corroborationFor(sourceCount) {
  if (sourceCount === 0) {
    return { corroborated_claims: [], uncorroborated_claims: [] };
  }
  const pair = sourceCount >= 2 ? [1, 2] : [1];
  const corroborated = [{
    claim: `${MOCK_MARK} A placeholder statement presented as corroborated so the downstream brief has material to carry.`,
    source_indices: pair,
    confidence: "high"
  }];
  if (sourceCount >= 3) {
    corroborated.push({
      claim: `${MOCK_MARK} A second placeholder statement, corroborated by a different pair of sources.`,
      source_indices: [2, 3],
      confidence: "medium"
    });
  }
  return {
    corroborated: corroborated,
    corroborated_claims: corroborated,
    uncorroborated_claims: sourceCount >= 4
      ? [{ claim: `${MOCK_MARK} A placeholder statement left uncorroborated on purpose, so the brief's exclusion path is exercised.`, confidence: "low" }]
      : []
  };
}

// The post. Deliberately digit free (see the header note on strict
// metric fidelity) and visibly a placeholder.
function generatedPost(topicName, angle) {
  const body = [
    `${MOCK_MARK} This post was produced by the Generation Lab's stand in vendor, not by a model.`,
    "",
    `Topic as the pipeline resolved it: ${topicName || "(none supplied)"}.`,
    `Angle as the pipeline resolved it: ${angle || "(none supplied)"}.`,
    "",
    "The paragraphs a model would write belong here. This text exists so the",
    "stages after generation have something real to operate on: hashtag merging,",
    "metric token substitution, the fidelity gate, and the quality review all run",
    "against these words exactly as they would against a model's output.",
    "",
    "Nothing above should be read as a claim about the world."
  ].join("\n");
  return {
    title: `${MOCK_MARK} Placeholder headline`,
    body: body,
    hashtags: ["GenerationLab", "PipelineTest"],
    sources_used: [1, 2]
  };
}

function qualityVerdict() {
  return {
    verdict: "pass",
    score: "n/a",
    unsupported_claims: [],
    tone: "consistent",
    notes: `${MOCK_MARK} No real review was performed. This verdict is fixed so the run reaches its end state.`
  };
}

/**
 * Build the vendor substitute for one Lab run.
 *
 * @param {{topicName?: string, angle?: string}} runContext
 *        Only what the operator already chose on the page. The mock
 *        never receives pipeline internals.
 * @returns {{anthropic: Function, orchestrated: Function}}
 */
export function createLabVendorMock(runContext = {}) {
  const topicName = runContext.topicName || "";
  const angle = runContext.angle || "";

  // Answers in the Anthropic SDK's response shape, for the stages
  // that call the SDK directly (research and corroboration).
  function anthropic(purpose, requestParams) {
    const prompt = (((requestParams || {}).messages || [])[0] || {}).content || "";
    let text;
    if (purpose === "web_search") {
      text = JSON.stringify(claimsFor(extractQueries(prompt)), null, 2);
    } else if (purpose === "corroboration") {
      const verdict = corroborationFor(countSources(prompt));
      text = JSON.stringify({
        corroborated_claims: verdict.corroborated_claims,
        uncorroborated_claims: verdict.uncorroborated_claims
      }, null, 2);
    } else {
      text = JSON.stringify({ note: `${MOCK_MARK} unrecognised purpose: ${purpose}` }, null, 2);
    }
    return {
      content: [{ type: "text", text: text }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "end_turn",
      model: "generation-lab-mock"
    };
  }

  // Answers in the orchestrator's canonical shape, for the stages
  // that go through the abstraction layer (generation and quality).
  function orchestrated(purpose) {
    const text = purpose === "quality_check"
      ? JSON.stringify(qualityVerdict(), null, 2)
      : JSON.stringify(generatedPost(topicName, angle), null, 2);
    return Object.freeze({
      text: text,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "end_turn",
      provider: "generation-lab-mock",
      model: "generation-lab-mock",
      costEstimateUsd: 0
    });
  }

  return { anthropic, orchestrated };
}
