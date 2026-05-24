# Post Generation Workflow — Technical Analysis

## What This Document Covers

This document maps the post generation pipeline to specific files, functions, line numbers, SQL queries, Anthropic request structures, and database writes. It is the code-level companion to Document 1 (Functional Analysis) and follows the same section numbering. Hardcoded values are flagged at point of use. Architectural gaps are called out at the end.

---

## 1. The Trigger

**Client:** `public_templates/index.html` → `handlePreview()` (line 301)

```javascript
fetch(`${API}/api/generate-preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topicId: selectedTopic || undefined })
});
```

`selectedTopic` is the value from the topic dropdown. If "All Topics" is selected, it sends `undefined` (omitted from JSON), which the server reads as `null`.

**Server:** `src/routes/api.js` → `router.post("/api/generate-preview", ...)` (line 372)

Middleware chain: `requirePermission("preview_post")` → handler. The handler wraps everything in `withTenant(req.tenant.id, ...)` so all downstream DB queries are RLS-scoped.

```
api.js:374  → topicId = req.body.topicId || null
api.js:376  → generatePost(topicId)            // content-generator.js:118
api.js:378  → qualityCheck(g.content, g.researchSummary)  // content-generator.js:323
api.js:382  → if generated.blocked → return blocked response (no quality check)
api.js:388  → return { post, quality }
```

---

## 2. Topic Selection

**File:** `src/services/content-generator.js`

**Entry:** `generatePost(topic, userSub)` (line 118)

```
line 119  → if topic is a string, look up via getTopicBySlug(topic)   // topic-store.js:90
line 122  → if topic is null, call selectNextTopic(userSub)           // content-generator.js:26
```

### selectNextTopic (line 26)

**SQL — get last posted topic:**

```
src/services/database.js → getLastPostedTopic()
```
```sql
SELECT t.slug FROM posts p
JOIN topics t ON t.id = p.topic_id
WHERE p.status = 'posted'::post_status
ORDER BY p.posted_at DESC LIMIT 1
```
RLS-scoped to current tenant.

**SQL — get recent posts (14 days):**

```
src/services/database.js → getRecentPosts(14)
```
```sql
SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
       p.hashtags, p.status, p.linkedin_id, p.created_at,
       p.scheduled_for, p.posted_at, p.error_message, p.news_context, p.image_url
FROM posts p
LEFT JOIN topics t ON t.id = p.topic_id
WHERE p.posted_at >= now() - ('14 days')::interval
  AND p.status = 'posted'::post_status
ORDER BY p.posted_at DESC
```
RLS-scoped to current tenant.

**SQL — get topics for generation:**

```
src/tenant/topic-store.js → getTopicsForGeneration(userSub)   // line 74
```
```sql
SELECT id, tenant_id, slug, name, description, user_sub,
       system_context, content_angles, hashtags, search_templates,
       weight, max_age_days, sort_order, enabled, created_at, updated_at
FROM topics
WHERE enabled = true
  AND (user_sub IS NULL OR user_sub = $1)
ORDER BY sort_order, created_at
```
`$1` = userSub (null for scheduler, user's sub for manual preview). RLS-scoped.

**Weighted selection algorithm (lines 35–72):**

```
For each topic (excluding the last posted):
  baseWeight     = topic.weight / totalWeight
  expectedShare  = baseWeight
  actualShare    = recentCountForTopic / totalRecentPosts
  balanceFactor  = expectedShare / max(actualShare, 0.05)
  finalWeight    = baseWeight * min(balanceFactor, 3.0)

Weighted random roll across candidates.
```

`0.05` floor and `3.0` cap are **hardcoded** (lines 51–52).

**Error — no topics:** line 31–33 throws `"No enabled topics available for content generation"`. Propagates to api.js catch block → 500.

---

## 3. Angle Selection

**File:** `src/services/content-generator.js` → `selectContentAngle(topic, recentPosts)` (line 77)

Reads `topic.content_angles` (JSONB array from the `topics` table, type `JSONB NOT NULL DEFAULT '[]'`).

**Fuzzy match logic (lines 86–93):**

```
For each of the 5 most recent posts on this topic:
  For each angle:
    Split angle into words, keep words > 4 chars
    Check how many appear in the post content
    If matchCount >= 3, mark this angle index as "used"
```

`5` (recent posts to check), `4` (minimum word length), `3` (match threshold) are **hardcoded** (lines 81, 88, 91).

Available pool = angles not marked as used. If all are used, pool reopens to all angles. Random selection from pool.

**Fallback:** If `content_angles` is empty → returns `"General discussion"` (line 79). **Hardcoded string.**

---

## 4. Research Phase — Gathering Material

**File:** `src/services/content-generator.js` line 134 → dynamic import of `src/services/research.js`

```javascript
const { conductResearch } = await import("./research.js");
researchBrief = await conductResearch(topic.slug, angle, cycleId, skipCorroboration);
```

`skipCorroboration` is read from `agent_state` at line 127:
```javascript
const skipCorroboration = (await getAgentState("corroboration")) === "disabled";
```

**SQL:** `SELECT value FROM agent_state WHERE key = 'corroboration'`

### conductResearch (research.js line 463)

```
line 467  → getTopicBySlug(topicId)        // resolve full topic object
line 480  → gatherRSSMaterial(topic, angle)  // Step 1: RSS
line 483  → gatherWebSearchMaterial(topic, angle, cycleId)  // Step 2: web search
line 527  → assembleAllSources(webClaims, rssArticles)
line 531  → if skipCorroboration: buildDirectBrief(allSources)
line 541  → else: corroborateClaims(allSources, cycleId) → buildVerifiedBrief(...)
```

**Error — topic not found:** line 468–477 returns a brief with `hasEnoughMaterial: false`. Downstream in content-generator.js line 161, this triggers the block.

### 4a. Track 1: RSS Articles — gatherRSSMaterial (research.js line 36)

**SQL — article query:**

```
src/services/news-monitor.js → getArticlesForTopic(topicSlug, maxAgeDays, 30)  // line 393
```
```sql
SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
       a.image_url, f.name AS feed_name, f.tier::text AS feed_tier
FROM articles_v2 a
JOIN feed_articles fa ON fa.article_id = a.id
JOIN feeds_v2 f ON f.id = fa.feed_id
LEFT JOIN feed_topics ft ON ft.feed_id = f.id
LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $1
WHERE (t.id IS NOT NULL OR f.is_catchall = true)
  AND a.published_at >= now() - ($2 || ' days')::interval
ORDER BY a.published_at DESC
LIMIT $3
```

`$1` = topicSlug, `$2` = maxAgeDays (from `topic.max_age_days`, default 14), `$3` = 30. RLS on `feeds_v2` and `feed_articles` scopes to current tenant. `articles_v2` has no RLS (global content table).

**Relevance scoring (lines 40–51):**

```
angleWords = angle split into words, filtered to length > 3
For each article:
  text = (title + " " + summary).toLowerCase()
  relevanceScore = count of angleWords found in text

Filter: relevanceScore > 0
Sort: descending by relevanceScore
Slice: top 10
```

`3` (min word length), `10` (max articles) are **hardcoded** (lines 40, 51).

### 4b. Track 2: Web Search — gatherWebSearchMaterial (research.js line 58)

**Always runs.** No conditional — web search is called for every generation regardless of RSS article count.

**Search query construction:** `buildSearchQueries(topicId, angle)` (line 174)

```javascript
const kw = extractKeywords(angle);  // line 203: stopword-filtered, first 5 words
const year = new Date().getFullYear();
const yearRange = `${year - 1} ${year}`;
```

**Topic-specific templates (lines 179–191):**

| topicId | Query pattern |
|---|---|
| `cybersecurity-incidents` | `${angle} ${yearRange}`, `recent cybersecurity breach ${kw}`, `${kw} incident report` |
| `cybersecurity-advances` | `${angle} new technology ${yearRange}`, `${kw} cybersecurity advancement`, `${kw} security tool release` |
| `ai-practical-benefit` | `${angle} real world results`, `${kw} AI implementation case study`, `${kw} enterprise AI ${yearRange}` |
| `ai-guardrails` | `${angle} AI safety framework`, `${kw} AI governance policy`, `${kw} responsible AI implementation` |

**Generic fallback (lines 195–200):**

```javascript
const topicName = topicId.replace(/-/g, ' ');
return [
  `${topicName} ${kw} ${yearRange}`,
  `${kw} ${topicName} case study analysis`,
  `${topicName} ${kw} expert report`
];
```

**Hardcoded:** The four topic-specific query maps (lines 179–191). New topics fall through to the generic builder. The old `_buildSearchQueries` function (lines 156–173) is dead code — still present in file, never called.

**Anthropic request — web search (line 68):**

```javascript
callAnthropic(client, {
  model,                    // from getAnthropicModel() fallback chain
  max_tokens: 2000,         // hardcoded
  tools: [{ type: "web_search_20250305", name: "web_search" }],  // hardcoded (parameterized in 1.4.6.1)
  messages: [{ role: "user", content: webSearchPrompt }]
  // No system prompt — user message only
})
```

**Response parsing (lines 104–114):**

```
Extract text blocks only (filter b.type === "text")
Strip markdown JSON fencing
Regex match for JSON array: /\[[\s\S]*\]/
Parse as array of { claim, source_name, source_url, source_date, confidence }
```

**Failure mode:** If the AI returns no parseable JSON array, returns `[]` (line 111). If the API call throws, returns `[]` (line 125). Neither is fatal — pipeline continues with RSS-only material.

### 4c. Source Assembly — assembleAllSources (research.js line 230)

Merges web claims and RSS articles into a flat array. Each item gets:

```javascript
{
  type: "web_search" | "rss",
  name: claim.source_name | article.feed_name,
  url: claim.source_url | article.link,
  date: claim.source_date | article.published_at,
  text: claim.claim | `${article.title}: ${article.summary.slice(0, 300)}`,
  confidence: claim.confidence | "high",   // RSS articles are always "high"
  tier: classifySourceTier(name) | article.feed_tier
}
```

RSS article summaries are truncated to 300 characters. **Hardcoded** (line 245).

**Trust tier classification — classifySourceTier (line 214):**

Pattern match against hardcoded lists of source names. Falls through to `"secondary"` if no match.

```
authoritative: "cisa", "nist", "fbi", "nsa", "enisa", "ncsc", "sec.gov", "ftc",
               "microsoft security response", "google project zero"
primary:       "krebs", "bleepingcomputer", "dark reading", "the record", "securelist",
               "schneier", "ars technica", "wired", "reuters", "associated press", "bbc",
               "nyt", "washington post", "google blog", "openai", "anthropic",
               "mit technology review"
```

**Hardcoded** (lines 216–222). Not configurable. Web search results get classified here; RSS articles use `feed.tier` from the database.

---

## 5. Corroboration ON — Path A

### 5a. Cooldown (research.js line 537–538)

```javascript
await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));  // COOLDOWN_MS = 65000
```

**Hardcoded** (line 30). Parameterized to `getCooldownMs()` in delivery 1.4.6.1.

**DB write:** `logActivity("info", "rate_limit_cooldown", { cycleId, message })` → INSERT into `activity_log`.

### 5b. Corroboration — corroborateClaims (research.js line 257)

**Guard:** If `allSources.length === 0`, returns `{ verified: [], belowThreshold: [], uncorroborated: [] }` immediately (line 258–261). No API call.

**Anthropic request — corroboration (line 268):**

```javascript
callAnthropic(client, {
  model,
  max_tokens: 2000,         // hardcoded
  messages: [{
    role: "user",
    content: corroborationPrompt
    // Prompt includes all source materials with index numbers:
    // [1] SourceName (tier, date): claim text
    // [2] SourceName (tier, date): claim text
    // ...
  }]
  // No system prompt. No tools.
})
```

**Prompt asks for JSON:**
```json
{
  "corroborated_claims": [{
    "claim": "...",
    "source_indices": [1, 4, 7],
    "source_count": 3,
    "confidence": "high|medium",
    "category": "event|statistic|announcement|analysis"
  }],
  "uncorroborated_claims": [{
    "claim": "...",
    "source_index": 2,
    "reason": "single source only"
  }]
}
```

**Response parsing (lines 306–315):**

```
Extract text blocks, strip fencing
Regex match for JSON object: /\{[\s\S]*\}/
Parse
```

**Failure modes:**
- No parseable JSON → returns `{ verified: [], belowThreshold: [], uncorroborated: [] }` (line 312)
- API call throws → same empty return (line 341)
- Both are non-fatal but produce 0 verified claims → downstream block

### 5c. Trust Scoring (lines 317–328)

```javascript
for each corroborated_claim:
  claimSources = claim.source_indices mapped to allSources array (1-indexed)
  trustWeight = sum of TRUST_TIERS[source.tier].weight for each source

  meetsThreshold = trustWeight >= SOURCE_RULES.minTrustWeight  // 3
```

**Constants from `src/config/feeds.js`:**

```javascript
TRUST_TIERS = {
  authoritative: { weight: 3 },
  primary:       { weight: 2 },
  secondary:     { weight: 1 }
};
SOURCE_RULES = {
  minIndependentSources: 2,
  minTrustWeight: 3
};
```

### 5d. Verified Brief — buildVerifiedBrief (research.js line 345)

Builds a text document with sections:
- `VERIFIED FACTS (corroborated by 2+ independent sources):`
- `UNCORROBORATED (DO NOT state as fact):`
- `SOURCE LIST:` with numbered citations

Returns:
```javascript
{
  context,                    // the text document
  sourceList,                 // array of { name, url, date, tier, citationIndex }
  sourceCount,
  independentSourceCount,     // distinct source names (case-insensitive)
  verifiedClaimCount,         // verified.length
  corroborationSkipped: false,
  hasEnoughMaterial: verified.length >= 1,  // THE GATE for Path A
  summary: { rssArticles, webClaims, independentSources, totalSourceItems,
             verifiedClaims, belowThreshold, uncorroborated }
}
```

**Gate threshold:** `hasEnoughMaterial = verified.length >= 1` (line 394). **Hardcoded.**

---

## 6. Corroboration OFF — Path B

### 6b. Direct Brief — buildDirectBrief (research.js line 411)

No cooldown, no API call. Builds from raw `allSources` directly.

Text format:
```
SOURCE MATERIAL (from N independent sources — corroboration skipped):

[1] (tier, type) SourceName (date):
   claim or article text

SOURCE LIST:
[1] SourceName — URL (date, tier: X)
```

Returns:
```javascript
{
  context,
  sourceList,
  sourceCount,
  independentSourceCount,
  verifiedClaimCount: 0,     // always 0 — no verification done
  corroborationSkipped: true,
  hasEnoughMaterial: independentCount >= SOURCE_RULES.minIndependentSources,  // THE GATE for Path B
  summary: { ... verifiedClaims: 0, belowThreshold: 0, uncorroborated: 0 }
}
```

**Gate threshold:** `hasEnoughMaterial = independentCount >= 2` (from `SOURCE_RULES.minIndependentSources`, feeds.js line 128).

---

## 7. Material Sufficiency Gate

**File:** `src/services/content-generator.js` lines 161–176

```javascript
if (!researchBrief || !researchBrief.hasEnoughMaterial) {
  const reason = !researchBrief
    ? "Research service unavailable"
    : skipCorroboration
      ? `Only ${researchBrief.independentSourceCount} independent source(s) found; minimum is 2`
      : `Only ${researchBrief.verifiedClaimCount || 0} verified claim(s) found; minimum is 1 from 2+ independent sources`;

  return { blocked: true, reason, topicId: topic.slug, angle, cycleId };
}
```

**DB writes on block:**
- `logActivity("info", "post_blocked_insufficient_sources", { cycleId, topicId, angle, reason })` → `activity_log`
- `platformLog("warn", "post_blocked_insufficient_sources", { cycleId, topicId, reason })` → stdout/PM2

**Client behavior (public_templates/index.html line 315–317):** `alert()` dialog showing topic, angle, and reason.

---

## 8. Content Generation

### 8a. Cooldown (content-generator.js line 178–180)

```javascript
await new Promise(resolve => setTimeout(resolve, 65000));  // hardcoded, parameterized in 1.4.6.1
```

### 8b. Context Assembly (content-generator.js lines 188–253)

**Research block shape differs by path:**

**Corroboration ON (lines 191–204):**
```
RESEARCH BRIEF (use ONLY these verified facts...):
=== BEGIN EXTERNAL CONTENT (UNTRUSTED...) ===
[verified facts, uncorroborated warnings, source list from buildVerifiedBrief]
=== END EXTERNAL CONTENT ===

CRITICAL SOURCE RULES:
- ONLY state facts from "VERIFIED FACTS"
- UNCORROBORATED claims: omit entirely
- Include attestation line
```

**Corroboration OFF (lines 206–217):**
```
SOURCE MATERIAL (N independent sources — corroboration step was skipped):
=== BEGIN EXTERNAL CONTENT (UNTRUSTED...) ===
[all source material from buildDirectBrief]
=== END EXTERNAL CONTENT ===

ATTRIBUTION RULES:
- Single-source claims: hedge ("one report suggests")
- Multi-source claims: state with attribution
- No attestation line
```

Both paths share:
- `frameUntrustedContent()` from `src/services/prompt-framing.js` (line 52) wraps the research context in injection-prevention boundaries
- Recent post summaries appended (last 6 posts, line 183–185). `6` is **hardcoded**.
- Writing requirements (lines 230–251): word count 150–280, first person, no emoji, no en/em dashes, etc.

### 8c. Anthropic request — generation (content-generator.js line 263)

```javascript
callAnthropic(client, {
  model,                          // from getAnthropicModel() fallback chain
  max_tokens: 1500,               // hardcoded
  system: topic.system_context,   // per-topic system prompt from DB
  messages: [{ role: "user", content: userPrompt }]
  // No tools
})
```

**Note:** This is the only Anthropic call in the pipeline that uses a `system` prompt. The web search and corroboration calls use user messages only. The `system_context` comes from the `topics` table (`TEXT NOT NULL DEFAULT ''`).

**Expected JSON response:**

```json
{
  "title": "Internal tracking title",
  "hook": "Opening 1-2 sentences",
  "body": "Full post with Sources: line",
  "hashtags": ["#Tag1", "#Tag2"],
  "sources_used": ["Source Name 1", "Source Name 2"]
}
```

**Response parsing (lines 270–272):**

```javascript
const raw = response.content[0].text.trim();
const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
const parsed = JSON.parse(cleaned);
```

**Hashtag merge (lines 274–277):**

```javascript
[...new Set([...parsed.hashtags, ...topicHashtags])].slice(0, 6);
```

Topic hashtags from DB merged with AI-suggested, deduplicated, capped at 6. **Hardcoded** cap.

**Return value (lines 293–309):**

```javascript
{
  cycleId, topicId: topic.slug, title: parsed.title,
  content: parsed.body, hashtags: allHashtags, angle,
  sourcesUsed: parsed.sources_used || [],
  articleImages: researchBrief.articleImages || [],
  researchSummary: {
    verifiedClaims, independentSources, totalSourceItems,
    corroborationSkipped, sourceList
  }
}
```

**DB writes on success:**
- `logActivity("info", "content_generation_success", { cycleId, topicId, model, title, wordCount, sourcesUsed, durationMs })` → `activity_log`
- `platformLog("info", "content_generation_success", { ... })` → stdout/PM2

**Error paths (lines 310–318):**
- JSON parse fails → `SyntaxError` thrown → caught by api.js line 389 → 500
- API call fails → SDK error thrown → caught by api.js → 500
- Credential decryption fails → `"Unsupported state or unable to authenticate data"` → caught by api.js → 500

---

## 9. Quality Check

**File:** `src/services/content-generator.js` → `qualityCheck(content, researchSummary, cycleId)` (line 323)

Called from `api.js` line 378, only if `generated.blocked` is false.

**Anthropic request — quality check (line 330):**

```javascript
callAnthropic(client, {
  model,
  max_tokens: 800,        // hardcoded
  messages: [{
    role: "user",
    content: qualityCheckPrompt
    // Includes: POST content, source context (source list, verified counts,
    // whether corroboration was completed or skipped)
  }]
  // No system prompt. No tools.
})
```

**Scoring criteria:** hook_strength, authenticity, actionability, engagement_potential, professionalism, source_grounding, factual_caution. Each 1–10.

**Pass/fail rule (in prompt, line 368):** `source_grounding < 5 OR factual_caution < 5 → pass = false`

**Response:** JSON with `scores`, `overall`, `pass`, `factual_flags`, `feedback`. Returned alongside the post to the client. **Does not block the preview.**

---

## 10. Complete Call Chain Summary

### Corroboration ON

```
api.js:372                  POST /api/generate-preview
  content-generator.js:118    generatePost(topicId)
    database.js                 getLastPostedTopic()           SQL
    database.js                 getRecentPosts(14)             SQL
    topic-store.js:74           getTopicsForGeneration()       SQL
    content-generator.js:26     selectNextTopic()              weighted random
    content-generator.js:77     selectContentAngle()           fuzzy match
    database.js                 getAgentState("corroboration") SQL
    research.js:463             conductResearch(slug, angle, cycleId, false)
      topic-store.js:90           getTopicBySlug()             SQL
      research.js:36              gatherRSSMaterial()           SQL (articles_v2)
      research.js:58              gatherWebSearchMaterial()     ★ ANTHROPIC CALL #1 (web_search tool)
      research.js:230             assembleAllSources()          in-memory merge
      research.js:537             cooldown                      sleep(getCooldownMs())
      research.js:257             corroborateClaims()           ★ ANTHROPIC CALL #2 (no tools)
      research.js:345             buildVerifiedBrief()          in-memory
    content-generator.js:161    sufficiency gate               go/no-go
    content-generator.js:180    cooldown                       sleep(getCooldownMs())
    content-generator.js:263    generation                     ★ ANTHROPIC CALL #3 (system prompt)
  content-generator.js:323    qualityCheck()                   ★ ANTHROPIC CALL #4 (no tools)
api.js:388                  return { post, quality }
```

**Total Anthropic calls: 4** (web search, corroboration, generation, quality check)

### Corroboration OFF

```
api.js:372                  POST /api/generate-preview
  content-generator.js:118    generatePost(topicId)
    [same topic/angle selection as above]
    research.js:463             conductResearch(slug, angle, cycleId, true)
      topic-store.js:90           getTopicBySlug()             SQL
      research.js:36              gatherRSSMaterial()           SQL (articles_v2)
      research.js:58              gatherWebSearchMaterial()     ★ ANTHROPIC CALL #1 (web_search tool)
      research.js:230             assembleAllSources()          in-memory merge
      research.js:411             buildDirectBrief()            in-memory (NO cooldown, NO API call)
    content-generator.js:161    sufficiency gate               go/no-go
    content-generator.js:180    cooldown                       sleep(getCooldownMs())
    content-generator.js:263    generation                     ★ ANTHROPIC CALL #2 (system prompt)
  content-generator.js:323    qualityCheck()                   ★ ANTHROPIC CALL #3 (no tools)
api.js:388                  return { post, quality }
```

**Total Anthropic calls: 3** (web search, generation, quality check)

---

## 11. Database Writes Per Request

| Stage | Table | Operation | What |
|---|---|---|---|
| Topic selection | (reads only) | SELECT | posts, topics |
| Research start | `activity_log` | INSERT | `research_started` event |
| Web search start | `activity_log` | INSERT | `web_search_started` with queries |
| Web search result | `activity_log` | INSERT | `web_search_complete` with claim count |
| Material gathered | `activity_log` | INSERT | `research_material_gathered` with feed breakdown |
| Cooldown | `activity_log` | INSERT | `rate_limit_cooldown` |
| Corroboration start/complete | `activity_log` | INSERT | `corroboration_started`, `corroboration_complete` |
| Research complete | `activity_log` | INSERT | `research_complete` with verified counts |
| Research integrated | `activity_log` | INSERT | `research_integrated` |
| Sufficiency block | `activity_log` | INSERT | `post_blocked_insufficient_sources` |
| Generation cooldown | `activity_log` | INSERT | `rate_limit_cooldown` |
| Generation start | `activity_log` | INSERT | `content_generation_started` |
| Generation success | `activity_log` | INSERT | `content_generation_success` with model, duration, word count |
| Generation failure | `activity_log` | INSERT | `content_generation_failed` |

No writes to `posts` during preview. Posts are only written when the user clicks "Save to Queue" (`/api/save-preview`, api.js line 395).

---

## 12. Hardcoded Values Inventory

| Value | Location | Description | Abstraction path |
|---|---|---|---|
| `0.05` | content-generator.js:51 | Balance factor floor in topic weighting | Config constant or agent_state |
| `3.0` | content-generator.js:52 | Balance factor cap | Config constant or agent_state |
| `5` | content-generator.js:81 | Recent posts checked for angle dedup | Config constant |
| `4` | content-generator.js:88 | Min word length for angle matching | Config constant |
| `3` | content-generator.js:91 | Angle word-match threshold | Config constant |
| `"General discussion"` | content-generator.js:79 | Fallback angle text | Config constant |
| `65000` | content-generator.js:180 | Generation cooldown ms | **Fixed in 1.4.6.1** → `getCooldownMs()` |
| `6` | content-generator.js:277 | Max hashtags | Config constant |
| `1500` | content-generator.js:265 | Generation max_tokens | Config or agent_state |
| `800` | content-generator.js:331 | Quality check max_tokens | Config or agent_state |
| `10` | research.js:51 | Max RSS articles after scoring | Config constant |
| `300` | research.js:245 | RSS summary truncation chars | Config constant |
| `65000` | research.js:30 | Research cooldown ms | **Fixed in 1.4.6.1** → `getCooldownMs()` |
| `2000` | research.js:70 | Web search max_tokens | Config constant |
| `2000` | research.js:270 | Corroboration max_tokens | Config constant |
| `"web_search_20250305"` | research.js:71 | Web search tool version | **Fixed in 1.4.6.1** → `getWebSearchTool()` |
| 4 topic query maps | research.js:179–191 | Topic-specific search queries | Database `search_templates` column exists but is unused |
| Source name lists | research.js:216–222 | Trust tier classification | Database or config file |
| `_buildSearchQueries` | research.js:156–173 | Dead code — old version of buildSearchQueries | Should be removed |

---

## 13. Architectural Gaps

**`search_templates` column exists but is never read.** The `topics` table has a `search_templates JSONB` column (populated by the topic manager UI). The `buildSearchQueries` function on line 174 does not read it — it uses hardcoded query maps for four known topics and a generic fallback for everything else. This column was designed to let users customize web search queries per topic, but the wiring was never completed.

**Web search always runs, even when RSS provides sufficient material.** There is no conditional that skips the web search if RSS articles already exceed the minimum threshold. Every preview request makes at least one Anthropic API call (web search) before evaluating whether enough material exists. This adds latency and token cost to every request.

**Trust tier classification is disconnected from the database.** RSS articles get their tier from `feeds_v2.tier` (database-driven, configurable per feed). Web search results get their tier from `classifySourceTier()` (hardcoded name lists, line 214). Adding a new authoritative source requires a code change for web search results but only a database update for RSS feeds.

**Quality check prompt has a hardcoded audience assumption.** Line 349: `"Appropriate for a cybersecurity/AI professional audience?"` This audience description should come from the topic's `system_context` or a tenant-level setting, not be baked into the quality check prompt.

**Dead code.** `_buildSearchQueries` (lines 156–173) is the original version of the search query builder. It was replaced by `buildSearchQueries` (line 174) but never removed.

**No timeout on individual Anthropic calls.** The `callAnthropic` wrapper (ai.js line 75) does not set a per-call timeout. A hung API call would block until the CloudFront origin timeout (120s) terminates the entire request. A per-call timeout (e.g., 30s) would allow the pipeline to fail fast and surface a specific error rather than a generic HTML timeout page.
