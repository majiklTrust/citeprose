## Table of Contents
- [1. Where the user enters: three doors, one platform](#1-where-the-user-enters-three-doors-one-platform)
- [2. The dashboard's functional job](#2-the-dashboards-functional-job)
- [3. The "no tenant" state — and what it signals about your invitation flow](#3-the-no-tenant-state--and-what-it-signals-about-your-invitation-flow)
- [4. The autonomy contract: what the agent actually does on its own](#4-the-autonomy-contract-what-the-agent-actually-does-on-its-own)
- [5. Multi-tenancy — implementation depth](#5-multi-tenancy--implementation-depth)
- [6. Credentials — per-tenant BYOK, encrypted with HKDF-derived keys](#6-credentials--per-tenant-byok-encrypted-with-hkdf-derived-keys)
- [7. RBAC — three roles, ten permissions, enforced two ways](#7-rbac--three-roles-ten-permissions-enforced-two-ways)
- [8. The route-existence pre-auth check — a Zero Trust detail](#8-the-route-existence-pre-auth-check--a-zero-trust-detail)
- [9. Deployment topology](#9-deployment-topology)
- [10. A small inconsistency worth surfacing](#10-a-small-inconsistency-worth-surfacing)
- [11. What the user experience actually feels like](#11-what-the-user-experience-actually-feels-like)
- [12. Categories of risk visible in the code](#12-categories-of-risk-visible-in-the-code)

# Opus 4.7 AI partnership for SaaS development lifecycle

**Created:** 4/24/2026 19:56:32  
**Updated:** 5/18/2026 13:06:49  
**Exported:** 5/18/2026 13:09:13  
**Link:** [https://claude.ai/chat/d81bc5aa-f5d7-4fdc-ad39-2ddc97ce081d](https://claude.ai/chat/d81bc5aa-f5d7-4fdc-ad39-2ddc97ce081d)  

## Prompt:
5/18/2026, 11:02:38 AM

> File: source-deploy-linkedin-ai-agent-1.0.155.zip

> File: source-linkedin-ai-agent-1.0.155-claudeupload.zip

> File: source-sql-linkedin-ai-agent-1.0.155.zip


I need answers instead of artifacts.  

Do deep analysis of the attachments, understand the functional use case on the code's impact to the user experience.



## Response:
5/18/2026, 11:07:06 AM

---

# Deep Analysis — v1.0.155 Source, SQL, and Deploy

**Category: design** (an analysis response, not a build/test/deploy step.)

The codebase has shifted significantly since the `appdev & deploy` transcript ended at version 1.x.x in early April. This is no longer a single-user LinkedIn agent. It's a **functional multi-tenant SaaS platform** with a marketing front door, an invitation-based onboarding flow, role-based access control, and BYOK Anthropic. Below is what the code *actually does for a real human user*, organized by who that user is and what they experience.

## 1. Where the user enters: three doors, one platform
[back to top ↩](#table-of-contents)

There are three entry surfaces, each serving a distinct functional purpose:

**`/` — the marketing homepage** (`alpha-site/index.html`). Branded "majiklTrust, Market Intelligence". Static HTML+CSS with one JS file (`scripts/site.js`) that does exactly one thing: probes `/auth/status` on page load, then adapts CTAs based on the result. If the visitor is signed in, the "Visit Dashboard" buttons point to `/app` and a user greeting appears in the header; if not, they point to `/auth/login`; if the probe fails, a degraded banner appears and CTAs disable. The hero copy is unusually restrained — "Inspired Research, your thoughts, your terms" — and the footnote says "Private alpha · Invitation only", which is consistent with the registration flow you've actually built (token-based, admin-issued).

**`/app/register` — invitation-based signup** (`public/register/`). Unauthenticated, token-gated. A new tenant arrives via an email link containing a registration token, validates it, optionally enters their own Anthropic API key (BYOK), picks a model, chooses a workspace slug + name, and the system provisions a tenant + initial owner membership in one shot. The token has a TTL (`getRegistrationTTL()` in platform-db.js), the admin-issued API key is itself stored encrypted-at-rest during the registration window (`encryptForRegistration` / `decryptForRegistration` use a registration-id-derived key), and `expireStaleRegistrations` cleans up unfinished invitations. This is a *real* onboarding pipeline, not a placeholder.

**`/app` — the operator dashboard** (`public/index.html`). React 18 SPA loaded via CDN with Babel-standalone in the browser. This is where everything happens once a user is in. Has three sibling management surfaces it links to based on role:
- `/app/topics/` — owner/editor only
- `/app/feeds/` — owner/editor only
- `/app/admin/` — owner only, dev-bypass blocked

## 2. The dashboard's functional job
[back to top ↩](#table-of-contents)

The dashboard exists to let an operator answer one question continuously: *"Is the agent doing its job, and do I need to intervene?"* Everything else is in service of that.

**Header**: Identity + role-visible nav links + Auto/Manual toggle. The mode toggle is the single most consequential control on the page — flipping to Auto means generated posts go straight to LinkedIn after passing quality checks; flipping to Manual means every post waits in a pending queue.

**Stats row** (four cards): Total Published, Posts (10-day) with a progress bar against `maxPostsPer10Days`, Pending Approval count, and LinkedIn connection status. The 10-day cadence bar turns amber when the operator is about to be cadence-blocked — that's the *only* hint the dashboard gives that the scheduler won't post even if asked. The "Connect now" link in the LinkedIn card is the entry to the OAuth flow; without it the agent can prepare posts but cannot publish.

**Main grid, left column**: Pending Approval section (amber-bordered cards) above Recent Posts. Clicking a card opens a modal with full content, sources used, quality scores, factual flags, and (for pending) Edit/Approve/Reject buttons. *This is the manual-mode workflow.* The operator skims, clicks, reads, approves, and the same `executePost` path that auto-mode uses fires.

**Main grid, middle column**: AI Model display (showing the resolved Anthropic model via the three-level fallback in `config/ai.js`), then Quick Actions (topic dropdown, corroboration toggle, Preview button, Force Cycle button — the latter disabled unless mode=auto with a tooltip explaining why). Then Research Monitor showing per-feed article counts color-coded by tier (authoritative/primary/secondary), then Topic Coverage showing recent post distribution by topic.

**The Force Cycle disable-when-manual decision is interesting**. Functionally it says: "manual mode means *you* drive; if you want a post right now, use Preview." That's a coherent UX choice but it's not obvious from the button alone — the tooltip carries the explanation.

## 3. The "no tenant" state — and what it signals about your invitation flow
[back to top ↩](#table-of-contents)

Lines 410–435 of the dashboard handle a specific case: an authenticated user with `status.stats === null`. This happens when someone has logged in via Auth0/WorkOS but has *no* membership row. They see a sidebar panel with "No Membership - Workspace Unassigned" and instructions to contact their admin. The comment in the code calls out a backlog item: "dedicated `/no-tenant` route would give a stable URL for tenant-provisioning emails."

**This is a real UX gap.** Today the flow is: user clicks an email link → completes registration → has a membership. But if anyone bypasses that (e.g., someone you give an Auth0 account to without running them through `/app/register`), they hit a dead-end panel telling them to log out and back in. The resolver does try invite-claim by email match (`findPendingInviteByEmail` in resolver.js), which softens this — but only if an invite exists for that exact email. The dead-end panel is the visible failure mode.

## 4. The autonomy contract: what the agent actually does on its own
[back to top ↩](#table-of-contents)

Two cron loops run in the Node.js process (`startScheduler` and `startMonitor`):

**News Monitor** (hourly, `cron.schedule("0 * * * *")`): Calls `listActiveTenants()`, iterates each, wraps in `withTenant`, fetches every RSS feed in `feeds_v2` for that tenant, sanitizes titles/summaries/links through `sanitize-content.js` (which also runs prompt-injection detection), upserts into the global `articles_v2` table, and links via `feed_articles` for tenant-scoped visibility. Catchall feeds (`is_catchall = true`) serve every topic without explicit `feed_topics` mappings — this is how a new tenant gets baseline coverage on day one without configuring anything.

**Scheduler** (twice daily, at `PREFERRED_POST_HOUR` and 12 hours later): Same per-tenant iteration pattern. For each tenant, runs `schedulerTick()`:
1. Skip if paused, skip if manual-mode with pending posts already waiting, skip if cadence rules deny (4 posts per 10 days, 72 hours between posts — both env-overridable).
2. Call `generatePost(null)` which picks a topic (weighted random with recency penalty), picks an angle (rotates within `content_angles` avoiding recently-used ones), and triggers the research pipeline.
3. Research: gather from RSS, call Anthropic with `web_search_20250305` tool to find current claims, optionally corroborate across sources (when corroboration toggle is enabled). If `hasEnoughMaterial` is false → **block the post entirely** rather than ship something unsourced. This is the v1.10.3 `minTrustWeight` lesson made structural.
4. If material is enough: wait 65 seconds (rate-limit cooldown), then generate the LinkedIn post body via Anthropic with strict source-attribution rules baked into the prompt (no em/en dashes, sources line required, attestation line if corroborated).
5. Quality check (separate Anthropic call) scoring hook strength, authenticity, actionability, source grounding, factual caution. If overall < 6 or `pass: false`, retry once.
6. Save to `posts` table. If mode=auto, immediately call `executePost`. If mode=manual, mark `pending_approval` and stop.
7. `executePost` runs `output-filter.js` (scans for leaked API keys, prompt fragments, base64 exfiltration) as a last gate before calling LinkedIn's `/v2/ugcPosts` endpoint.

**The most important functional fact**: the pipeline is willing to *not post* rather than post badly. There are at least four places where the chain can refuse to publish: insufficient sources, quality < threshold, output filter trip, LinkedIn API failure. Each writes to `activity_log` so the operator can see *why*.

## 5. Multi-tenancy — implementation depth
[back to top ↩](#table-of-contents)

The userMemories described this as in-progress. The code shows it landed and works.

**Isolation model**: silo per tenant logically, but physically one PostgreSQL database with RLS. Every tenant-scoped table (`topics`, `posts`, `agent_state`, `activity_log`, `credentials`, `feeds_v2`, `feed_topics`, `feed_articles`) has `tenant_id UUID NOT NULL` and is wrapped in:
```
ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
ALTER TABLE ... FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ... USING (tenant_id = current_tenant_id());
```
`current_tenant_id()` reads `app.current_tenant_id` from `current_setting()`. The Node side (`with-tenant.js`) uses `AsyncLocalStorage` to carry the tenant through the call stack and `set_config('app.current_tenant_id', $1, true)` to set it per transaction. `FORCE ROW LEVEL SECURITY` closes the table-owner-bypass hole. The `liagt_app_runtime` role explicitly does **not** have `BYPASSRLS` — only `linkedin_agent_admin` does, for migrations.

**Defense in depth**, exactly as the SQL comments claim: (1) RLS in the database, (2) composite FK pattern in the schema, (3) explicit tenant scoping in the application via `withTenant`. All three would have to fail simultaneously for cross-tenant data exposure.

**Articles are different — and this is correct**. `articles_v2` is global with no RLS; one URL = one row regardless of how many tenants subscribe to its feed. Tenant access is enforced only through `feed_articles` (which *is* RLS'd). This is the "shared global articles" decision from the late-transcript design discussion, and it's exactly the right call: fetching the Krebs on Security feed for every tenant separately is wasteful when the article content is identical.

## 6. Credentials — per-tenant BYOK, encrypted with HKDF-derived keys
[back to top ↩](#table-of-contents)

`credential-store.js` is the most security-critical file. Each tenant has a derived key:
```
HKDF-SHA256(
  IKM:  process.env.ENCRYPTION_SECRET,
  salt: tenant UUID,
  info: "credential-encryption-v1",
  L:    32 bytes
)
```
Cached in a `Map` keyed by tenant UUID (safe because derivation is deterministic). Plaintext is *never* cached. The on-disk ciphertext format is `iv (12) || authTag (16) || ciphertext`, AES-256-GCM. Three credentials are stored per tenant: `anthropic_api_key`, `linkedin_access_token`, `linkedin_person_urn`.

**Functional consequence**: each tenant brings their own Anthropic API key. Their costs hit their account. You don't aggregate or front API costs for them. The dashboard shows the resolved model (per-tenant override → env → hardcoded `claude-haiku-4-5-20251001` default). The hardcoded default is explicitly flagged in `config/ai.js` as a hardcoded value with a documented abstraction path (`ANTHROPIC_MODEL` env var, or per-tenant via `agent_state`). That matches the project rule about flagging hardcoded values and offering a parameterized replacement.

## 7. RBAC — three roles, ten permissions, enforced two ways
[back to top ↩](#table-of-contents)

From `05-role_permissions.sql`:

| Permission | owner | editor | viewer |
|---|---|---|---|
| view_dashboard | ✓ | ✓ | ✓ |
| preview_post | ✓ | ✓ | ✓ |
| edit_post | ✓ | ✓ | ✓ |
| approve_reject_post | ✓ | ✓ | ✓ |
| force_cycle | ✓ | ✓ | — |
| refresh_feeds | ✓ | ✓ | — |
| change_mode | ✓ | ✓ | — |
| toggle_corroboration | ✓ | ✓ | — |
| connect_linkedin | ✓ | ✓ | — |
| manage_users | ✓ | — | — |

Enforced server-side via `requirePermission(name)` middleware that hits the `role_permissions` table (with a process-level cache and a `_resetPermissionCacheForTesting` escape hatch). Enforced *visually* in the dashboard by gating the Topics/Manage Users nav links on `status.user.role`.

**Functional note**: the viewer role can edit and approve posts but can't toggle modes or force a cycle. That's an interesting product decision — viewers are content reviewers, not operators. Whether that matches your business intent or is an artifact of incremental design is worth asking explicitly later.

## 8. The route-existence pre-auth check — a Zero Trust detail
[back to top ↩](#table-of-contents)

Lines 50–80 of `routes/api.js` register a middleware that runs *before* `requireAuth` and returns 404 for any `/api/*` path that isn't a registered route. This prevents the "authenticated-only 401 leak" — where a 401 vs 404 response distinguishes "this endpoint exists, you just lack auth" from "this endpoint doesn't exist". Unknown paths get a uniform 404 regardless of whether they'd require auth. That's a real Zero Trust implementation detail, not just a label.

## 9. Deployment topology
[back to top ↩](#table-of-contents)

Twenty-two scripts in `deploy/`, sequentially numbered with `config.sh` sourced by all. Reading them straight through:

`config.sh` → region/domain/CIDR/instance type (`m7i-flex.large`), Ubuntu 24.04 LTS AMI from Canonical (`099720109477`), `ubuntu` SSH user, port 3001, `majikl.com` / `alpha.majikl.com`.

The phases: `01-vpc-network` → `02-security` (security groups) → `03-certificate` + `03b-wait-cert` (ACM) → `04-compute` (EC2 + EBS gp3 20GB + Elastic IP) → `04b-database` (Postgres via Podman on the same EC2; clones the GitHub repo too) → `05-loadbalancer` (ALB) → `06-application` (deploys via SSH + PM2) → `06a-validation` → `07-verify` → `08-cloudfront` → `08b-wait-cloudfront` → `08c-lockdown-alb` (restricts ALB to CloudFront-only after CF is live) → `08x-cloudfront` (the teardown).

State chains through `.deploy-state`. Each script extracts what it needs via `grep KEY .deploy-state | tail -1 | cut -d= -f2`. Reversible: `teardown.sh` exists, `08x-cloudfront.sh` is the targeted CF reversal, and several scripts (`resize-instance.sh`, `delete-cloudfront-distribution.sh`, `audit-cloudfront-state.sh`) are ops utilities rather than first-deployment steps.

**The architecture is interim by design** — the userMemories notes the long-term direction is serverless (ECS Fargate or Lambda+API Gateway). The current EC2-with-co-located-Postgres-in-Podman is appropriate for a private alpha but won't scale past a handful of tenants. Specifically, two real bottlenecks are baked in:
- The cron loops iterate all active tenants serially in one process. At 50+ tenants the hourly news monitor will start overlapping with itself.
- The Postgres container shares the EC2 instance with the Node app. Memory pressure from either side affects the other.

Neither is a problem today.

## 10. A small inconsistency worth surfacing
[back to top ↩](#table-of-contents)

`src/index.js` line 367 hardcodes the banner text as `LinkedIn AI Content Agent v1.0.112` but the actual version is 1.0.155, set in `package.json` and threaded everywhere else through `{{VERSION}}` template substitution. The banner shows v1.0.112 in startup logs while the dashboard correctly shows v1.0.155. **This is a hardcoded value that drifted** — exactly the class of bug your rules call out. Not a functional defect (it's a log message), but it's the kind of thing the build template system was designed to prevent and it slipped through because the banner is in `src_templates/index.js` literally, not as `{{VERSION}}`.

## 11. What the user experience actually feels like
[back to top ↩](#table-of-contents)

Putting it together — what does this product *do for someone using it*?

A subject-matter expert (SME) — say, a cybersecurity consultant — receives a registration email. They click the link, validate, paste their own Anthropic API key, pick a model, name their workspace, and land on a dashboard. The agent is already polling RSS feeds via the catchall feeds set up at registration. Within an hour, the Research Monitor shows article counts climbing. The SME picks Manual mode, clicks "Preview New Post" with "Auto-select topic". After ~3 minutes (research + cooldown + generation + quality check), a preview appears in pending approval. They click in, read it, see the Sources line and the corroboration attestation, click Approve, and it ships to LinkedIn under their name.

After a week or two of approving content they trust, they flip to Auto. The scheduler runs at 9am and 9pm. Twice a week, on average, a post they didn't have to think about goes live with proper sourcing. They check the dashboard maybe once a day. The 10-day cadence bar keeps them from spamming their own feed. The corroboration toggle is the dial that controls how strict the agent is about fact-grounding — turn it off and posts ship faster but with looser attribution; turn it on and posts are sometimes blocked entirely for lack of sources.

**The product's actual value proposition**, expressed as what the code enforces: *consistent, sourced, on-topic LinkedIn presence with operator-in-the-loop control over how strict and how autonomous.*

## 12. Categories of risk visible in the code
[back to top ↩](#table-of-contents)

Not asking for fixes, just naming what I see:

- **Cron iteration without parallelism cap**: `runTickForAllTenants` and `runPollForAllTenants` await each tenant sequentially. Operationally fine now; will need a concurrency limiter before tenant count grows past ~10 with non-trivial feed counts.
- **`req.user.email` dependency for invite claim**: some social logins (notably Apple's "Hide My Email") give Auth0 a relay address. The invite-claim path matches on email; that path will silently fail for those users and they'll see the "No Membership" panel.
- **The 60-second rate-limit cooldown is a hardcoded `await sleep(65000)` in two places** (research.js and content-generator.js). When a tenant uses a higher Anthropic tier, this cooldown is wasted time. Worth parameterizing eventually.
- **PostgreSQL pool is shared across all tenants**. RLS protects data, but a runaway query for tenant A can starve tenant B's pool slots. Per-tenant connection budgets are a future concern.
- **`syntheticDevUser` runs whenever `!isAuthEnabled()` OR `isDevBypass(req)`**, including under `NODE_ENV=production` if no providers happen to be configured. The userMemories already lists "syntheticDevUser refuses to run when NODE_ENV=production" as pending hardening — confirmed, still pending.
