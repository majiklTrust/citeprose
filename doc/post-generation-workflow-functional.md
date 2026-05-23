# Post Generation Workflow — Functional Analysis

## What This Document Covers

This document describes what happens, in plain language, from the moment a user clicks "Preview New Post" through to the final quality-checked draft appearing on screen. It covers how topics and angles are selected, how research articles are gathered and evaluated, when the system reaches out to the web for additional material, and every decision point where the system chooses not to generate a post. The corroboration toggle (on vs. off) creates two distinct paths through the pipeline, and each is described separately where behavior diverges.

---

## 1. The Trigger

The user clicks "Preview New Post" on the dashboard. If the user has selected a specific topic from the dropdown, that topic is sent with the request. If no topic is selected, the system chooses one automatically.

---

## 2. Topic Selection

If the user specified a topic, the system looks it up directly and uses it. If no topic was specified, the system picks one using a weighted rotation that balances two goals: respect the weight assigned to each topic (topics with higher weights are chosen more often) and avoid repeating the same topic that was posted most recently.

The rotation works as follows. The system retrieves all enabled topics and the last 14 days of posts. It calculates how often each topic should have appeared (its expected share based on weight) versus how often it actually appeared. Topics that are underrepresented get a boost; topics that are overrepresented are penalized. The most recently posted topic is excluded entirely. A weighted random roll then selects from the remaining candidates.

If only one topic exists and it was the last one posted, the exclusion filter is lifted and that topic is used anyway.

**Decision point — generation stops if:** No enabled topics exist. The system raises an error: "No enabled topics available for content generation."

---

## 3. Angle Selection

Each topic carries a list of content angles — specific writing prompts or perspectives stored in the database. The system picks an angle that hasn't been used recently by comparing each angle's keywords against the last five posts for that same topic. Angles where three or more significant words appear in a recent post are considered "used" and are deprioritized.

If all angles have been recently used, the full list reopens and any angle can be selected. If a topic has no angles defined at all, the system falls back to "General discussion."

---

## 4. Research Phase — Gathering Material

The research phase runs in two parallel tracks that are then merged.

### 4a. Track 1: RSS Articles (no AI call, instant)

The system queries the database for articles linked to the selected topic. Articles qualify through two paths: they belong to a feed that is explicitly mapped to this topic, or they belong to a "catchall" feed (broad-coverage feeds that serve all topics). Only articles published within the topic's configured freshness window are included (typically 14–30 days depending on the topic). The query returns up to 30 articles, ordered newest first.

These articles are then scored for relevance to the selected angle. Each article's title and summary are checked for words that appear in the angle text (ignoring short common words). Articles with zero matching words are discarded. The remaining articles are ranked by match count, and the top 10 are kept.

### 4b. Track 2: Web Search (AI call #1)

The system always performs a web search regardless of how many RSS articles were found. The search is done by sending the AI a request with the web search tool enabled. The AI receives three search queries tailored to the topic and angle.

For topics that have pre-built query templates (cybersecurity-incidents, cybersecurity-advances, ai-practical-benefit, ai-guardrails), the queries combine the angle text and extracted keywords with topic-specific suffixes like "incident report" or "case study." For any other topic, generic queries are constructed from the topic name, keywords, and a year range.

The AI executes the web searches and returns a structured list of claims — each containing the specific factual statement, the source name, source URL, publication date, and a confidence rating. The system asks for 5–15 claims from diverse sources, preferring material from the last 30 days.

**If the web search fails** (network error, API error, malformed response), it returns an empty list and the pipeline continues with RSS material only. This is not treated as a fatal error.

### 4c. What Happens After Articles Are Chosen

The RSS articles and web search claims are merged into a unified source list. Each item is tagged with its origin (RSS or web search), its source name and URL, its publication date, and a trust tier classification.

Trust tiers are assigned based on the source name. Government and standards bodies (CISA, NIST, FBI, SEC) are classified as "authoritative." Major original-reporting outlets (Krebs on Security, Reuters, BBC, Wired, MIT Technology Review) are classified as "primary." Everything else is classified as "secondary."

Article images from the RSS articles are also collected at this point for the optional post image picker.

The pipeline now diverges based on the corroboration toggle.

---

## 5. Corroboration ON — The Verified Path

### 5a. Cooldown

A mandatory pause runs before the corroboration AI call to space out API requests and avoid rate limit errors.

### 5b. Corroboration (AI call #2)

The merged source list is sent to the AI with instructions to act as a fact-checking analyst. The AI groups related claims that describe the same event or finding, determines which claims appear in two or more independent sources (same parent organization does not count), and rejects any specific statistic or percentage that doesn't appear in at least two independent sources.

The AI returns two lists: corroborated claims (with the source indices that support them) and uncorroborated claims (single-source only).

### 5c. Trust Scoring

Each corroborated claim is scored by adding up the trust tier weights of its supporting sources. Authoritative sources contribute 3 points, primary sources contribute 2 points, and secondary sources contribute 1 point. A claim passes the trust threshold if its combined weight reaches 3 or higher. This means, for example, that two primary sources are sufficient (2+2=4), or one authoritative plus one secondary (3+1=4), but two secondary sources alone are not (1+1=2).

Claims that were corroborated by the AI but don't meet the trust weight threshold are labeled "below threshold" and marked as uncorroborated in the research brief.

### 5d. The Verified Brief

The system builds a structured document containing three sections: verified facts (with citation numbers), uncorroborated claims (with a warning to omit or hedge), and a numbered source list. This document becomes the research context for the content generation step.

**Decision point — generation stops if:** Fewer than 1 verified claim survives the trust scoring. The user sees: "Only N verified claim(s) found; minimum is 1 from 2+ independent sources." The post is blocked.

---

## 6. Corroboration OFF — The Direct Path

### 6a. No Cooldown, No Corroboration Call

The corroboration AI call and its preceding cooldown are both skipped entirely. The merged source list goes directly into a research brief without any claim verification.

### 6b. The Direct Brief

The system builds a source-material document listing every item from both RSS and web search, tagged with its source name, tier, origin type, and publication date. No claims are marked as verified or unverified — the brief presents the raw material and notes that corroboration was skipped.

**Decision point — generation stops if:** Fewer than 2 independent source names exist across all material. The user sees: "Only N independent source(s) found; minimum is 2." The post is blocked.

---

## 7. Material Sufficiency Gate

This is the go/no-go decision that applies to both paths before content generation begins. The criteria differ by path.

### Corroboration ON

The research brief must contain at least 1 verified claim (a claim corroborated by 2+ independent sources with a combined trust weight of 3 or higher). If the research phase itself threw an error (API failure, unexpected exception), the brief is null and generation is blocked with "Research service unavailable."

### Corroboration OFF

The research brief must contain at least 2 distinct, independent source names across all collected material (RSS + web search combined). If the research phase threw an error, the same "Research service unavailable" block applies.

**If the gate blocks generation:** The system returns a structured response to the dashboard with `blocked: true`, the reason, the topic, and the angle. The dashboard shows an alert dialog explaining why and suggesting the agent will try a different topic or angle on the next cycle. No AI generation call is made. No post is created.

---

## 8. Content Generation (AI call #3 or #2)

### 8a. Cooldown

A mandatory pause runs before the generation call, same purpose as the research cooldown.

### 8b. Context Assembly

The system builds a prompt containing: the topic name, the selected angle, the research brief (verified or direct, depending on the path), and summaries of the last six posts (to avoid repeating themes).

The prompt rules differ by path.

With corroboration ON, the prompt instructs the AI to use ONLY verified facts, omit anything marked uncorroborated, include source attribution in the post body, include a Sources line, and include an attestation line stating sources were verified through multi-source corroboration.

With corroboration OFF, the prompt instructs the AI to base claims on the source material, use hedging for single-source claims ("one report suggests"), state multi-source claims more directly with attribution, include source attribution and a Sources line, but no attestation line.

Both paths share the same writing requirements: 150–280 words, first person, one concrete example, a closing question, no emoji, no excessive bullets, no en/em dashes, no clichés, no hashtags in the body.

### 8c. The AI Writes the Post

The prompt is sent to the AI with the tenant's configured model. The response is expected as JSON containing a title (internal, not published), a hook (the opening lines), the full post body, suggested hashtags, and a list of sources used.

The AI-suggested hashtags are merged with the topic's pre-configured hashtags, deduplicated, and capped at six total.

**Decision point — generation stops if:** The AI response cannot be parsed as JSON (malformed output). The error propagates to the dashboard as "An internal error occurred." The API key is invalid or the credential cannot be decrypted — same user-facing error. The AI call times out or returns an error — same user-facing error.

---

## 9. Quality Check (AI call #4 or #3)

After the post is generated, a separate AI call evaluates it across seven criteria on a 1–10 scale: hook strength, authenticity, actionability, engagement potential, professionalism, source grounding, and factual caution.

The quality check receives the post content and the research summary (how many verified claims, how many independent sources, whether corroboration was completed or skipped). It returns scores, an overall rating, a pass/fail judgment, any factual flags (specific claims that appear unsupported), and constructive feedback.

The pass/fail rule: if source grounding scores below 5 OR factual caution scores below 5, the post fails regardless of other scores.

**The quality check does not block the preview.** Both the post and the quality scores are returned to the dashboard together. The user sees the draft alongside the quality assessment and decides whether to save it to the approval queue, request a new one, or discard it.

---

## 10. Complete List of Decision Points That Stop Generation

### Stops that apply regardless of corroboration setting

| When | What the user sees |
|---|---|
| No enabled topics exist | Error: "No enabled topics available for content generation" |
| Research phase throws an unrecoverable error | Blocked: "Research service unavailable" |
| Anthropic API key missing or undecryptable | Error: "An internal error occurred" |
| AI generation call fails (timeout, API error) | Error: "An internal error occurred" |
| AI response is not parseable as JSON | Error: "An internal error occurred" |
| Request exceeds CloudFront origin timeout (120s) | Error: "Unexpected token '<', <!DOCTYPE..." (HTML timeout page returned instead of JSON) |

### Stops specific to corroboration ON

| When | What the user sees |
|---|---|
| Zero verified claims survive trust scoring | Blocked: "Only 0 verified claim(s) found; minimum is 1 from 2+ independent sources" |
| Corroboration AI call fails | Corroboration returns empty results; verified claim count is 0; post is blocked as above |

### Stops specific to corroboration OFF

| When | What the user sees |
|---|---|
| Fewer than 2 independent source names across all material | Blocked: "Only N independent source(s) found; minimum is 2" |

### Conditions that degrade quality but do not stop generation

| Condition | Effect |
|---|---|
| Web search returns no claims | Pipeline continues with RSS articles only; fewer sources available |
| RSS returns no relevant articles | Pipeline continues with web search claims only |
| Multiple RSS feeds are broken (404, parse errors) | Fewer articles in the pool; may push source count below the minimum threshold |
| Topic has no content angles defined | Falls back to "General discussion" — post will be generic |
| All content angles were recently used | Angle selection reopens the full list — may repeat a recent theme |
| Quality check scores below passing threshold | Post and scores are returned to user; not blocked, user decides |
