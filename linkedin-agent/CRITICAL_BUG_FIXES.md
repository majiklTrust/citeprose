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