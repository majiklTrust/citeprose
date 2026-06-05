Here are both lists.

---
May 8, 2026
## List 1: Title + Short Description

**Security**
1. Post Multi-Tenant Security Hardening — syntheticDevUser refuses production, platformLog audit
2. Security Header Tests — re-run Step 8 with NODE_ENV=production
3. Admin Page Information Disclosure — static HTML served to unauthenticated users
4. EXIF Metadata Stripping — strip GPS/device data from uploads
5. AI-2: Web Search Result Validation — reject oversized/malformed claims JSON
6. AI-4: LLMjacking / Credit Abuse — per-cycle token counting and limits
7. AI-5: Feed Integrity Classification — domain-based trust, not display name
8. AI-6: Model Extraction Resistance — prevent prompt leakage in output
9. API Rate Limiting — no brute-force protection on endpoints
10. CSRF Protection — unauthenticated forms lack CSRF tokens
11. Registration Token Validation Attempts — rate limit currently in-memory only

**LinkedIn API**
12. LinkedIn API Migration — ugcPosts to /rest/posts + versioned headers
13. Community Management API Application — pending LinkedIn approval
14. Image Attachment Phase 1 — user upload, blocked on API migration
15. Image Attachment Phase 2 — AI image generation, TBD
16. LinkedIn Token Refresh Automation — manual re-auth every 60 days
17. LinkedIn Company Page Publishing — w_organization_social scope

**Database**
18. Database Pool Error Handling — pg-pool crash on connection timeout
19. FK CASCADE DDL File Updates — 02.1, 06, 09 need ON DELETE corrections
20. v2 Table Suffix Rename — articles_v2→articles, feeds_v2→feeds
21. seed-feeds.sql RETURNING Bug — re-run skips feed_topics mappings
22. topics.max_age_days Default Mismatch — DDL says 14, code says 20
23. tsvector Full-Text Search — on articles_v2 for keyword search
24. Catchall Feeds Hardcoded vs Configurable — frozen constants vs database/config

**Research Pipeline**
25. search_templates Column — JSONB on topics, never populated
26. buildSearchQueries Hardcoded Templates — replace with DB-driven templates
27. extractKeywords Word-Length Filter — drops "AI", splits hyphens wrong
28. gatherWebSearchMaterial Fragile Parsing — no timeout, regex JSON extraction
29. classifySourceTier Hardcoded Matching — publication name string matching
30. corroborateClaims Fragile Mapping — AI-dependent source index mapping
31. _buildSearchQueries Dead Code — unused function in research.js

**Features**
32. Quick Action CTA Readiness Gate — disable buttons when data insufficient
33. Feed Suggest/Discover — suggest feeds when creating topics
34. Per-User Content Isolation — per-user LinkedIn URN and post filtering
35. Brand-Configurable Templates — .env then database branding
36. Instagram POC — six-phase plan, not started
37. Topics & Feeds Manager — UI for managing feed-topic mappings

**Infrastructure**
38. Serverless Migration — EC2 to ECS Fargate or Lambda
39. README Update — outdated, missing research/registration/multi-tenant
40. src_templates/index.js Over 600 Lines — exceeds file length limit
41. src/config/feeds.js FEEDS Dead Code — array unused, TRUST_TIERS still used
42. 1500ms Inter-Feed Delay Hardcoded — in pollAllFeeds
43. 60-Day Article Pruning Hardcoded — in pollAllFeeds

---

## List 2: Title + Relevant Details

**Security**

**1. Post Multi-Tenant Security Hardening**
Three fixes: (a) `syntheticDevUser()` refuses to run when `NODE_ENV=production`, (b) `dotenv.config override:false` so runtime NODE_ENV wins over .env — COMPLETED in 1.0.96, (c) `platformLog` when synthetic user activates. Origin header spoofability is mitigated by NODE_ENV gate but documented.

**2. Security Header Tests**
Re-run `test-step8.sh` Phase 1 Step 8 security header tests including HSTS test with `NODE_ENV=production` before next production AWS deployment. Tests exist but haven't been run against production configuration.

**3. Admin Page Information Disclosure**
`/app/admin/` serves static HTML to unauthenticated users. The JavaScript blocks access on load (redirect to dashboard), but the HTML structure and element IDs are visible. A server-side middleware check would prevent the HTML from being served at all.

**4. EXIF Metadata Stripping**
JPEG images can contain GPS coordinates, device info, and other sensitive metadata. Flagged during image upload design. LinkedIn strips some EXIF on ingest, but defense-in-depth says strip before uploading. Requires a dependency like `sharp`. Deferred to Phase 2 of image feature.

**5. AI-2: Web Search Result Validation**
The `gatherWebSearchMaterial` function in research.js doesn't validate web search result structure. Oversized or malformed claims JSON from the AI response could cause errors or injection. Need: input size check, schema validation on the parsed claims array, suspicious pattern detection (e.g., "ignore instructions", "system prompt").

**6. AI-4: LLMjacking / Credit Abuse Mitigation**
No per-cycle token counting or budget enforcement. The Anthropic API key is live and callable whenever the server runs. Need: token usage tracking per generation cycle, configurable daily/monthly budget cap, abort generation if limit exceeded, alert logging when approaching threshold.

**7. AI-5: Feed Integrity — Domain-Based Trust Classification**
`classifySourceTier()` in research.js matches publication names by substring (e.g., `name.includes("Reuters")`). An attacker could create a feed named "Reuters Fake News" and get primary tier trust. Fix: match on URL domain (`new URL(url).hostname`), not display name.

**8. AI-6: Model Extraction / Prompt Stealing Resistance**
System prompts and content_angles are included in AI API calls. If the generated output echoes these instructions (via prompt injection), internal prompts become public on LinkedIn. Need: output scanning for system prompt fragments, rate limiting on preview generation to prevent rapid extraction attempts.

**9. API Rate Limiting**
No rate limiting on any API endpoint. Identified in the original security audit as medium severity. Recommendation: in-memory sliding window per IP, 100 requests per 15-minute window, configurable via `RATE_LIMIT_MAX` in .env. Critical endpoints: `/api/register/*`, `/auth/login`, `/api/posts/*/approve`.

**10. CSRF Protection**
Authenticated routes use session cookies with `sameSite=lax` which provides partial CSRF protection. Unauthenticated forms (registration) use the registration token as implicit CSRF protection. A formal CSRF token mechanism would be defense-in-depth.

**11. Registration Token Validation Attempts**
The `validate-key` endpoint tracks attempts per token in an in-memory `Map`. Server restart resets the counter. For a 60-minute TTL window, this is acceptable but a persistent counter (database or Redis) would survive restarts.

---

**LinkedIn API**

**12. LinkedIn API Migration**
The current publishing pipeline uses the deprecated `ugcPosts` (`/v2/ugcPosts`) API. LinkedIn's Posts API (`/rest/posts`) is the replacement. Migration requires: versioned `Linkedin-Version: YYYYMM` header, new payload structure (simpler, less nested), Images API (`/rest/images?action=initializeUpload`) for media uploads. The deprecation currently applies to Marketing partners only; `w_member_social` via "Share on LinkedIn" still works.

**13. Community Management API Application**
Application to LinkedIn Developer portal is in progress. Grants access to `/rest/posts`, `/rest/images`, company page management (`w_organization_social`, `r_organization_social`), and employee advocacy (`w_member_social`). The working app serves as the demo asset for the application. Strategic framing: company page management as primary use case.

**14. Image Attachment Phase 1 — User Upload**
Design complete, code built (1.0.107, not deployed). Workflow: user attaches image during post approval → base64 in JSON (no multer) → server validates magic bytes (JPEG/PNG/GIF) → uploads to LinkedIn → includes image URN in post. In-memory only, no database changes. Blocked on LinkedIn API migration — the Assets API (`registerUpload`) may not work; the Images API requires Community Management access.

**15. Image Attachment Phase 2 — AI Image Generation**
Not designed. Depends on Phase 1 being live. Concept: AI generates a relevant image for the post topic using DALL-E or similar, attached automatically during content generation.

**16. LinkedIn Token Refresh Automation**
LinkedIn access tokens expire after ~60 days. Currently requires manual re-authentication via `/auth/linkedin`. LinkedIn supports programmatic refresh tokens for some products. Need: automatic refresh before expiry, token expiry monitoring, alert when refresh fails.

**17. LinkedIn Company Page Publishing**
Requires `w_organization_social` and `r_organization_social` scopes from Community Management API. Would allow publishing to company pages (not just personal profiles). Strategic value: employee advocacy workflows where posts go to the company page.

---

**Database**

**18. Database Pool Error Handling**
`pg-pool` crashes the process with "Connection terminated due to connection timeout" during `findTenantByAuthIdentity`. Cause: no `error` event handler on the pool. Server crashes instead of recovering. Fix: `pool.on('error', ...)` handler + connection retry logic + `idleTimeoutMillis`/`connectionTimeoutMillis` tuning. Test written (`test-pool-error.sh`) but not run — test delivery paused.

**19. FK CASCADE DDL File Updates**
The ALTER TABLE commands to fix CASCADE on `feeds_v2`, `feed_topics`, `feed_articles`, and `invites` were applied to the test database but the DDL source files (`02.1-feeds-normalize.sql`, `06-invites.sql`) haven't been updated. Fresh builds from DDL would create the wrong constraints. `09-tenant-registration.sql` also needs `ON DELETE SET NULL` added explicitly.

**20. v2 Table Suffix Rename**
`articles_v2` and `feeds_v2` still carry the `_v2` suffix from the migration. The old `articles` and `feeds` tables were dropped in 1.0.92. The rename (`ALTER TABLE articles_v2 RENAME TO articles`) is safe but requires updating every query reference across: news-monitor.js, research.js, seed-defaults.js, seed-feeds.sql, all RLS policies, and all grants.

**21. seed-feeds.sql RETURNING Bug**
`INSERT ... ON CONFLICT DO NOTHING RETURNING id` returns nothing when the row already exists. Running seed-feeds.sql after feeds already exist creates 0 feed_topics mappings. Workaround: delete feeds first, then re-run. Fix: use insert-then-lookup pattern (as implemented in seed-defaults.js).

**22. topics.max_age_days Default Mismatch**
DDL in `02-tenant-tables.sql` defines `max_age_days INTEGER DEFAULT 14`. All code defaults use 20. New topics created via SQL without specifying max_age_days get 14 instead of the intended 20. Fix: `ALTER TABLE topics ALTER COLUMN max_age_days SET DEFAULT 20`.

**23. tsvector Full-Text Search**
`articles_v2` has no full-text search index. The `searchArticles` function uses `ILIKE` for keyword matching. Adding a `tsvector` column with a GIN index would enable proper PostgreSQL full-text search with ranking, stemming, and phrase matching.

**24. Catchall Feeds Hardcoded vs Configurable**
The 15 catchall feeds are frozen constants in `seed-defaults.js`. The platform admin cannot add or remove catchall feeds without a code deployment. Long-term fix: template tables (`default_feeds`) or a platform admin UI for managing the default feed list.

---

**Research Pipeline**

**25. search_templates Column**
The `topics` table has a `search_templates JSONB` column that was never populated. Intended to store per-topic search query templates that replace the hardcoded `buildSearchQueries` logic. Each topic would define its own search patterns.

**26. buildSearchQueries Hardcoded Templates**
`buildSearchQueries()` in research.js has hardcoded per-slug templates for the original 4 topics. A generic catchall was added (1.0.93) using slug-derived domain context. Full replacement with `search_templates` from the database is deferred.

**27. extractKeywords Word-Length Filter**
The keyword extraction function filters words shorter than 3 characters, which drops "AI" — one of the most important keywords. Hyphenated compounds like "real-time" are split into "real" and "time" instead of being preserved.

**28. gatherWebSearchMaterial Fragile Parsing**
Uses regex to extract JSON from the AI response. No timeout on the AI call. No minimum claim count warning — if the AI returns 0 claims, the pipeline proceeds with nothing. Fix: structured output (JSON mode), timeout, minimum threshold.

**29. classifySourceTier Hardcoded Matching**
Source tier classification uses hardcoded publication name substrings. See also AI-5 above — this is both a maintainability issue and a security vulnerability.

**30. corroborateClaims Fragile Mapping**
The corroboration step asks the AI to map claims to source indices. The AI sometimes returns indices that don't exist in the source array, causing silent failures. The mapping is inherently fragile because it depends on the AI correctly referencing array positions.

**31. _buildSearchQueries Dead Code**
An unused function prefixed with underscore in research.js. Leftover from a refactor. Should be removed.

---

**Features**

**32. Quick Action CTA Readiness Gate**
Disable "Preview New Post" and topic selector when the tenant lacks topics, feeds, feed-topic mappings, or recent articles. Backend: add `readiness` object to `/api/status` with counts. Frontend: disable CTAs when any count is zero, show diagnostic message. Query designed, not implemented.

**33. Feed Suggest/Discover**
When creating topics, suggest existing feeds from the tenant's feed library and discover new RSS sources via AI. Would allow users to build topic-specific feed lists from the UI instead of requiring SQL.

**34. Per-User Content Isolation**
Each user connects their own LinkedIn account (URN stored per user_sub, not just tenant_id). Posts created by and published to specific users. Dashboard filters by logged-in user. Requires changes to: credentials table (add user_sub), posts table, publishing pipeline. Dependencies: per-user LinkedIn URN in credentials table.

**35. Brand-Configurable Templates**
Phase 1: single brand from `.env` (`BRAND_NAME`, `BRAND_TAGLINE`) via request-time template rendering — partially done (BRAND_NAME used in registration emails). Phase 2: multi-tenant from database via `resolveTenant` middleware. CSS theming via CSS custom properties. Open questions: which strings get placeholders, dashboard rebranding scope.

**36. Instagram POC**
Six-phase plan produced: Prerequisites → Auth → Read-Only Intelligence → Publishing → Engagement → AI Pipeline → DM Automation. Not started. Separate from LinkedIn functionality.

**37. Topics & Feeds Manager**
UI for managing feed-to-topic mappings. Currently, only catchall feeds serve topics automatically. Topic-specific feed assignments require SQL. A management page would let users browse available feeds, assign them to topics, and configure per-feed settings.

---

**Infrastructure**

**38. Serverless Migration**
Move from EC2 (m7i-flex.large) to ECS Fargate or Lambda/API Gateway. Current EC2 is interim. PostgreSQL would need to move to RDS or remain co-located with a different strategy.

**39. README Update**
The README is outdated from v1.5.0. Missing: research layer, RSS feeds, corroboration, multi-tenant architecture, registration flow, catchall feeds, Auth0 integration, deployment scripts, security hardening phases. Held off until features stabilize.

**40. src_templates/index.js Over 600 Lines**
Currently 621+ lines, exceeds the 600-line project limit. Needs splitting into separate modules — route mounting, middleware configuration, and server lifecycle.

**41. src/config/feeds.js FEEDS Dead Code**
The `FEEDS` array is unused after migration to feeds_v2 database table. `TRUST_TIERS` and `SOURCE_RULES` are still used by the research pipeline. The dead array should be removed.

**42. 1500ms Inter-Feed Delay Hardcoded**
`pollAllFeeds()` in news-monitor.js has a hardcoded 1500ms delay between feed fetches. Should be configurable via `.env` or `agent_state`.

**43. 60-Day Article Pruning Hardcoded**
`pollAllFeeds()` prunes `feed_articles` older than 60 days. This window is hardcoded. Should be configurable, potentially per-tenant via `agent_state`.

---


### 1 "Post Multi Tenant User Security Hardening".
Real gaps  
Gap 1 — dotenv.config({ override: true }). Your start() function loads .env with override: true. If someone puts NODE_ENV=dev in the production .env file, it silently overwrites the NODE_ENV=production you passed at runtime. The runtime value is gone. Dev bypass activates on a production server.  
Gap 2 — DEV_BYPASS_SUB has no environment guard. If DEV_BYPASS_SUB is accidentally in the production .env, and Gap 1 occurs, every request gets that identity without authentication. There's no code that says "refuse to read DEV_BYPASS_SUB when NODE_ENV is production."  
Gap 3 — Origin header is spoofable. DEV_BYPASS_ORIGINS checks the HTTP Origin header. Browsers enforce Origin honestly, but a raw HTTP client (curl, scripts, attackers) can send any Origin they want. The existing test suite (test-p3-step7-adversarial) already flagged this — the defense is that NODE_ENV must also be 'dev', so spoofing Origin alone isn't enough.  
Gap 4 — No log trail when synthetic user activates. If dev bypass fires, nothing is logged. An attacker who managed to flip NODE_ENV to 'dev' would leave no evidence in the activity log.  
Recommended hardening  
Three changes, in priority order:  
Fix 1 — syntheticDevUser() should refuse to run in production. Add a production guard at the top of the function:  å
jsif (process.env.NODE_ENV === 'production') return null;  
Even if all other defenses fail, the synthetic user is never injected in production. Defense in depth.  
Fix 2 — Change dotenv.config({ override: true }) to override: false. Runtime values should win over .env values. A deployment script that passes NODE_ENV=production on the command line should not be overridden by a stale .env file. This is a one-word change in src_templates/index.js.  
Fix 3 — Log when synthetic user activates. Add a platformLog("warn", "dev_bypass_synthetic_user", { sub }) call so there's an audit trail.
Want me to ship these three hardening fixes now? They're small and self-contained.  




### 2 enhance research.js and news-monitor.js

### 3 Post Multi-Tenant Security Hardening (pinned since Phase 2).

syntheticDevUser() refuses to run when NODE_ENV=production
dotenv.config with override: false so runtime NODE_ENV wins over .env
platformLog when synthetic user activates
Origin header spoofability mitigated by NODE_ENV gate but documented



### 4 Security header tests — re-run Phase 1 Step 8 (test-step8.sh) including HSTS test with NODE_ENV=production before next AWS deployment

### 5 /app/admin/ information disclosure — pen test finding: static HTML served to unauthenticated users. No data leaks (API returns 401), but page source reveals endpoint paths and client-side logic
## Database — Cleanup
### 6 Old feeds and articles tables — still created by 02-tenant-tables.sql. No RLS, no grants, no application code references them. Dead weight. Update 02 to remove them.

### 7 src/config/feeds.js — the FEEDS array is dead code. TRUST_TIERS and SOURCE_RULES constants are still imported by research.js. Clean up: move the constants elsewhere, delete the file or mark the array as deprecated.

### 8 v2 table suffixes — articles_v2 and feeds_v2 were named to avoid collision during migration. Once old tables are removed from 02, rename to articles and feeds. Requires updating all application code, DDL, and RLS/grants.
## Per-User Content Isolation (Future Workstream)
### 9 user_sub on posts — each post needs to record who created it. Without it, the dashboard can't filter "show me only my posts."

### 10 Per-user LinkedIn URN — credentials table currently stores one LinkedIn connection per tenant. Each user needs their own. Requires user_sub column on credentials.

### 11 Per-user publishing pipeline — posts published to the specific user's LinkedIn account, not a shared tenant connection.

### 12 Dashboard post filtering — Awaiting Approval and Recent Posts scoped by role: owner sees all, editor sees own, viewer sees global topic posts only.
## Topics — Remaining Work
### 13 Topic selector dropdown — fixed in 1.0.83 (reads from API). Confirmed working.

### 14 search_templates column — exists on topics table (JSONB, default []), never populated. Designed to replace buildSearchQueries() hardcoded per-slug templates. AI generation endpoint should suggest search templates alongside angles and hashtags.

### 15 topics.max_age_days default — column default is 14 in the DDL, but we set the standard to 20. New topics created via createTopic don't explicitly set it, so they get 14 from the DB default.

## research.js — Improvements Identified But Deferred

### 16 buildSearchQueries() — hardcoded per-slug query templates with stale year references ("2025 2026"). Should be replaced by search_templates from the database. High priority — blocks new topics from getting quality search results.
### 17 extractKeywords() — word-length filter of 3 drops "AI". Hyphenated compounds split incorrectly. Medium priority.
### 18 gatherWebSearchMaterial() — fragile JSON regex extraction, no timeout on Anthropic call, no minimum claim count warning. Medium priority.
### 19 classifySourceTier() — hardcoded publication name matching. Only relevant for web search results (RSS articles get tier from feeds_v2). Low priority.
### 20 corroborateClaims() — AI-dependent corroboration with fragile source index mapping. Hybrid deterministic/AI approach would be more reliable. Low priority.
### 21 tsvector full-text search on articles_v2 — ILIKE with leading wildcards forces sequential scans. Performance optimization for later.

## Dashboard UI

### 22 src_templates/index.js — 610 lines, 10 over the 600-line limit. Needs a route or middleware extraction.
### 23 Dashboard template regression risk — public_templates/index.html has been modified many times. Edit feature was lost once and rebuilt.

## Hardcoded Values

### 24 POSTS_WINDOW_DAYS and dashboard feed constants — flagged but not parameterized.
### 25 1500ms inter-feed delay in pollAllFeeds() — hardcoded, doesn't scale with large feed counts.
### 26 60-day pruning window in pollAllFeeds() — hardcoded in the DELETE query.

## Infrastructure / Deployment

### 27 Brand-configurable templates — Phase 1 (single brand from .env) and Phase 2 (multi-tenant from DB) not started.
### 28 LinkedIn API expansion — Community Management API application in progress.
### 29 Instagram POC — six-phase plan produced, not started.
### 30 Serverless migration — ECS Fargate or Lambda/API Gateway. Current EC2 is interim.
### 31 AI deferred phases — AI-2, AI-4, AI-5, AI-6 pipeline hardening queued.
---
June 5, 2026
---

## Auth0 (built or designed, not yet deployed)
- **1.6.53** — encrypt `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` (built, not deployed)
- **1.6.54** — `auth0.js` hardening: startup config-resolved log, fail-loud redirect/logout URI checks, `isSameOrigin` open-redirect guard on logout `returnTo`, callback-failure logging (built, not deployed)
- Production URI hardening — set explicit `AUTH0_REDIRECT_URI` / `AUTH0_LOGOUT_URI` as public HTTPS URLs with a production fail-loud guard instead of the localhost default
- Re-enable the AUTH0 secrets in the validator's `ENCRYPTED_SECRETS` once the above is live

## Secrets / encryption at rest
- AWS KMS / Secrets Manager (Option C) — move the `ENCRYPTION_SECRET` root and all `.env`-encrypted secrets to Secrets Manager / SSM, fetched at boot via the EC2 IAM role

## Prompt vault
- Platform-admin prompt-editor feature (HELD — you weren't ready to decide): view/decrypt-to-edit/save-new-version, `prompt_vault_history` table + `version` column, dedicated endpoints, diff/placeholder/render previews, rollback, audit. Interim path: edit `seed-prompt-vault.js` in git and re-run.
- Prompt Vault Phases 2–5 — ephemeral assembly, RBAC, response hardening, segmentation/synthesis

## Corroboration / research config
- Per-tenant corroboration match count via `agent_state` + tenant settings UI + impact preview (the env-var `MIN_INDEPENDENT_SOURCES` shipped in 1.6.71; the per-tenant version is the future step)
- `minTrustWeight` parameterization + syncing the hardcoded `"2+"` label at `research.js:340` to it

## Generation performance
- Async job pattern for `generate-preview` (return a job ID, poll) — the real fix for the CloudFront 60s origin-timeout conflict; the 1.6.70 TTL bump doesn't resolve that ceiling

## Multi-tenant
- Multi-tenant Day 1 — schema + tenant resolver, no data movement yet
- Per-user content isolation — each user connects their own LinkedIn account; `user_sub` in the credentials table, posts-table and publishing-pipeline changes, dashboard filtered by logged-in user
- Post-multi-tenant user security hardening (3 fixes) — `syntheticDevUser()` refuses when `NODE_ENV=production`; `dotenv` `override:false` so runtime `NODE_ENV` wins; `platformLog` when the synthetic user activates

## Branding
- Brand-configurable templates — Phase 1 single brand from `.env` (`BRAND_NAME` / `BRAND_TAGLINE`), Phase 2 multi-tenant from the DB via `resolveTenant`, then CSS theming via custom properties

## LinkedIn / integrations
- LinkedIn MDP API verification — Advertising API, Community Management API, Live Events API access verification (Community Management API application in progress)
- LinkedIn Disconnect endpoint — `POST /api/linkedin/disconnect`, deletes token/URNs and clears the validation cache
- Instagram integration — six-phase POC (auth/token → publishing → AI pipeline → DM automation)

## Monitoring
- Persist `platformLog` events to a DB table; add read-only platform-admin queries for prompt-access audit trails and usage metrics

## Infrastructure
- Move toward serverless (ECS Fargate or Lambda/API Gateway); current EC2 is interim

## Testing / pre-deploy gating
- Rerun Phase 1 Step 8 security-header tests (`test-step8.sh`), including the HSTS test with `NODE_ENV=production`, before any production AWS deploy

## UI / session (minor)
- Session fix 3 — expiry countdown banner (pending)
- UX — space out / reorder the `Queue · Edit · Discard` buttons (flagged during 1.6.72, not bundled; the misclick is now harmless but the layout still invites it)

## SQL-in-source (Phase 4) — assessed, not deferred but *decided against*
- Recommended against wholesale SQL externalization as a security measure (queries are parameterized, none is web-visible, isolation is RLS-enforced). The one proportionate open to-do from that assessment: **verify an RLS policy exists on every tenant-scoped table** (read-only check). Centralizing SQL for maintainability remains an optional future choice, not a security item.

A few of these are decision-gated rather than effort-gated — the Auth0 drops in particular are built and just waiting on your call to deploy. Want me to flag which ones block a production deploy versus which are safe to keep deferred?
