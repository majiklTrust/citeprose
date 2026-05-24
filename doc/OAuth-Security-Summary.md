## Table of Contents
- [Dimension 1 — Token lifetimes](#dimension-1--token-lifetimes)
- [Dimension 2 — Scopes](#dimension-2--scopes)
- [Dimension 3 — Refresh token handling](#dimension-3--refresh-token-handling)
- [Dimension 4 — PKCE usage](#dimension-4--pkce-usage)
- [Dimension 5 — Client authentication](#dimension-5--client-authentication)
- [Dimension 6 — Storage practices](#dimension-6--storage-practices)
- [Dimension 7 — Callback / completion handling](#dimension-7--callback--completion-handling)
- [Dimension 8 — Provider identification (cross-cutting)](#dimension-8--provider-identification-cross-cutting)
- [Six high-leverage architectural changes (Run 5 prioritization)](#six-high-leverage-architectural-changes-run-5-prioritization)

# Opus 4.7 AI partnership for SaaS development lifecycle

**Created:** 4/24/2026 19:56:32  
**Updated:** 5/18/2026 13:26:02  
**Exported:** 5/18/2026 13:27:18  
**Link:** [https://claude.ai/chat/d81bc5aa-f5d7-4fdc-ad39-2ddc97ce081d](https://claude.ai/chat/d81bc5aa-f5d7-4fdc-ad39-2ddc97ce081d)  

## Response:
5/18/2026, 1:26:02 PM

# Summary — OAuth Token Security Posture

**Category: design** (synthesis summary, no code produced)

This summary condenses Runs 1–4 (and Run 5's chains) into a navigable format. Each named dimension contains a Group 1 row (what exists) and a Group 2 row (what the risk is), with each of the four token systems represented across columns. Severity codes: **H** high, **M** medium, **L** low, **—** not implemented, **n/a** not applicable.

For full details on any cell, refer back to the corresponding finding ID (Lxx for LinkedIn / Run 1, Axx for Auth0 / Run 2, Rxx for Registration / Run 3, Wxx for WorkOS / Run 4).

---

## Dimension 1 — Token lifetimes
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | Lifetime mechanism |
|---|---|
| **LinkedIn** | ~60-day access token (LinkedIn-issued). Validity probed via `/v2/userinfo` call. No stored `expires_at`. 10-min cache on validity status. |
| **Auth0** | Session cookie `maxAge: 5 minutes`. Underlying Auth0 access token typically 24h (its `expires_in` is stored in payload as `expiresAt` but is *not* the cookie's lifetime). |
| **Registration** | 15-min TTL default (env-overridable). Enforced in DB (`expires_at > now()`) and client-side polling. Downstream pending owner invite has **no expiration set**. |
| **WorkOS** | — Not implemented. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | M | Token validity is probe-only with no inventory of which tokens are stale; combined with the missing refresh-token persistence (see Dimension 3), tokens drift unmanaged for the full 60 days (L1, L2). |
| **Auth0** | H | The 5-minute cookie forces near-continuous re-authentication and trains operators to click through OAuth consent without scrutiny — *consent fatigue is a phishing-susceptibility multiplier*. The `expiresAt` field semantic is also confusing and a `isSessionExpiring` helper exists but is never called (A1, A2, A4). |
| **Registration** | **H** | The downstream owner invite has no expiration. Combined with weak email verification (Dimension 7), this enables tenant takeover years later via domain re-registration — the canonical Slack/Zoom/Atlassian attack (R1). 15-min TTL is also UX-tight enough to pressure admins to extend it platform-wide. |
| **WorkOS** | M (future) | If implemented by copy-paste from Auth0, inherits all Auth0 lifetime defects. WorkOS access tokens default to ~10 minutes — refresh logic becomes *essential*, not optional. |

---

## Dimension 2 — Scopes
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | Scopes |
|---|---|
| **LinkedIn** | `openid profile w_member_social` — hardcoded. Platform-wide, same for every tenant. No read scopes. No `r_member_social` (closed by LinkedIn). |
| **Auth0** | `openid profile email` by default (env-configurable). No `offline_access` (no refresh token issued). Audience defaults to `"https://linkedin-agent-api"`. |
| **Registration** | Token grants three capabilities: read metadata (`/init`), probe Anthropic key (`/validate-key`), create tenant (`/complete`). All three under one bearer. |
| **WorkOS** | — Not implemented. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | M | `w_member_social` lets the agent post — and *delete arbitrary past posts*. Stolen token's blast radius is the operator's entire LinkedIn history, not just agent-created content (L4). |
| **Auth0** | M | Missing `offline_access` is consistent with the short sessions but cements the consent-fatigue pattern. Email-claim-based invite-claim path needs `email_verified` gating which isn't enforced (A5, A6). Audience default silently rolls forward (A7). |
| **Registration** | M | Single bearer for three distinct capabilities (read, probe, create) is reasonable for 15-min single-use but compounds the impact of any token leak (R5). |
| **WorkOS** | M / **H** (future) | Hardcoded scopes will repeat. `email_verified` semantics vary across WorkOS connection types (SAML may omit, OIDC may stringly-type) — implementing the R22 gate becomes connection-aware work (W2, W3). |

---

## Dimension 3 — Refresh token handling
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | Refresh handling |
|---|---|
| **LinkedIn** | Refresh token captured in `exchangeCodeForToken` return value. **Never persisted, never used.** Token expiration produces a "Not Connected" UI; user must re-OAuth manually. |
| **Auth0** | Refresh token captured (when `offline_access` is set, which it isn't by default) and **written to session cookie payload**. Cookie payload is re-decrypted on every request. Refresh token is never read. |
| **Registration** | No refresh mechanism. Single-use by design. Expired tokens require a new admin-issued invite. |
| **WorkOS** | — Not implemented. WorkOS rotates refresh tokens on use by default; copy-paste from Auth0 would not handle rotation. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | **H** | Most operationally significant finding in Run 1. The unstored refresh token forces 60-day re-OAuth cycles, conditioning operators to click through LinkedIn consent screens — same consent-fatigue logic as Auth0 but on a longer cycle (L7). |
| **Auth0** | **H** | Refresh token rides along in the session payload, gets decrypted on every request, and is never consumed. *Pure blast-radius expansion with no benefit* — if `SESSION_SECRET` leaks, the refresh token leaks. Either use it or strip it (A8). |
| **Registration** | n/a | Single-use design is correct. |
| **WorkOS** | M (future) | Same risk as Auth0 plus rotation-on-use complication. The "store once, use forever" pattern from Auth0 breaks under WorkOS rotation semantics (W4). |

---

## Dimension 4 — PKCE usage
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | PKCE |
|---|---|
| **LinkedIn** | None. State parameter present (256-bit random, single-use, 10-min TTL). |
| **Auth0** | None. State parameter present (separate 256-bit store in `providers/auth0.js`, but **the runtime callback uses the LinkedIn state store, not the Auth0 one**). |
| **Registration** | n/a — not OAuth. Pure bearer; URL-fragment delivery + `history.replaceState` scrub of address bar. |
| **WorkOS** | — Not implemented. WorkOS requires PKCE for public clients; recommended for confidential clients; trending mandatory. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | M | Missing PKCE is meaningful for code-leakage via referrer/log/mix-up attacks even with confidential client. State validation itself is sound (L10, L11 confirmed clean). |
| **Auth0** | **H** | Two findings stack: (a) missing PKCE same as LinkedIn (A10); (b) **the Auth0 callback uses the LinkedIn state store** — both providers share one state Map, creating a cross-flow confusion surface. The Auth0 provider's own state code is dead (A11). |
| **Registration** | **H** | Token plaintext in URL fragment is exposed post-load to anything running in the page (XSS, extensions, screen recorders, browser sync, history). `replaceState` doesn't unwind pre-JS captures (R7). |
| **WorkOS** | L → H (future) | Not required today for confidential clients; will become required as WorkOS deprecates non-PKCE flows. Implement-time finding (W5). |

---

## Dimension 5 — Client authentication
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | Client auth |
|---|---|
| **LinkedIn** | `client_secret_post` with form-URL-encoded body. `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` from env. **One OAuth app shared across all tenants.** |
| **Auth0** | `client_secret_post` with JSON body (spec-deviation). `AUTH0_CLIENT_ID` + `AUTH0_CLIENT_SECRET` from env. One Auth0 app shared across all tenants. SSRF blocklist + redirect-URI safety check enforced at init. |
| **Registration** | Token-issuer endpoint (`/invite`) gated on platform-admin check via `PLATFORM_ADMIN_SUBS` env allowlist. Token is `randomBytes(32).toString("base64url")` — 256 bits. |
| **WorkOS** | — Not implemented. Error message references `WORKOS_API_KEY` but no code reads it. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | **H** | Single shared OAuth app = single point of failure. LinkedIn revoking the app for any reason (TOS, compliance, one bad tenant) takes down every tenant simultaneously. No rotation procedure (L13, L14). |
| **Auth0** | **H** + M | Same shared-client structural finding as LinkedIn (A13). Plus: SSRF blocklist gaps (DNS rebind, IPv4-mapped IPv6, decimal/octal encoding — A15), redirect-URI `startsWith` substring match permits `http://localhost.evil.com` (A16). |
| **Registration** | **H** + M | `isPlatformAdmin` is `.env` string allowlist — no DB role, no audit trail, no time-bounded escalation (R10). Admin can pre-provide an Anthropic API key the registrant never sees, weaponizing platform admin into a per-tenant observability attack (R11). |
| **WorkOS** | M / **H** (future) | `WORKOS_API_KEY` error message is misleading documentation; WorkOS uses three distinct credentials. First implementer makes a naming decision that sticks. Shared-client problem will repeat (W6, W7). |

---

## Dimension 6 — Storage practices
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | Storage |
|---|---|
| **LinkedIn** | Encrypted in `credentials` table (RLS-protected). AES-256-GCM. Key: HKDF-SHA256 from `ENCRYPTION_SECRET` salted with tenant UUID. Format: `IV(12) ‖ authTag(16) ‖ ciphertext`. Per-tenant derived-key cache in process (no eviction). |
| **Auth0** | Encrypted httpOnly cookie (`__la_session`). AES-256-GCM. Key: HKDF-SHA256 from `SESSION_SECRET`, empty salt. Format: `IV(12) ‖ ciphertext ‖ authTag(16)` (note: different order from credentials store). `secure: NODE_ENV === 'production'`, `sameSite: 'lax'`. |
| **Registration** | Token: **plaintext** `TEXT NOT NULL UNIQUE` in `tenant_registrations`. Admin-provided API key: AES-256-GCM with **PBKDF2-SHA512** (100k iterations) derived from `ENCRYPTION_SECRET` + registration UUID. Format: `IV(12) ‖ authTag(16) ‖ ciphertext`. |
| **WorkOS** | — Not implemented. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | **H** + M | `ENCRYPTION_SECRET` is single root for all tenants' credentials; combined with a DB dump, recovers everything (L17). Derived-key cache never evicts — memory disclosure grows with process lifetime (L18). Format lacks key-version byte; rotation requires atomic re-encrypt (L20). |
| **Auth0** | M ×6 | Two encryption-secret roots (`SESSION_SECRET` + `ENCRYPTION_SECRET`) managed identically (A17). Empty HKDF salt forecloses salt-rotation (A18). `secure` flag only in production (A19). `req.user.raw` carries full JWT payload (A22). Ciphertext format differs from credential store (A21). |
| **Registration** | **H** + M | **Token stored plaintext** in DB — equivalent to storing passwords unhashed; insider DB read = mass takeover during the 15-min window (R13). Three KDFs for the same threat (HKDF×2 + PBKDF2) is maintenance-hazard inconsistency (R14). `clearRegistrationKey` is best-effort; failures leave encrypted keys lingering in `claimed` rows (R19). |
| **WorkOS** | M (future) | Cookie size budget vs. WorkOS's larger JWTs needs verification at implementation time (W8). |

---

## Dimension 7 — Callback / completion handling
[back to top ↩](#table-of-contents)

### Group 1 (what exists)

| Token system | Callback |
|---|---|
| **LinkedIn** | State → error → session → tenant → `withTenant` → exchange → profile → store → 1.5s client-redirect. Dev-bypass fallback honors `DEV_BYPASS_SUB` when `NODE_ENV=dev`. Provider inferred from sub prefix. |
| **Auth0** | Error → state → exchange → userinfo → `createSession`. Runtime callback in `src/index.js` is *not* the one in `providers/auth0.js::getRoutes` (the provider's version is dead code that returns tokens as JSON to the browser). |
| **Registration** | `validateToken` → resolve admin-or-user-provided key → atomic CTE creating tenant + claiming token → `withTenant` provisioning (set state, store credential, seed feeds) → create pending owner invite → return success. **Provisioning steps are NOT in a single transaction.** |
| **WorkOS** | — Not implemented. |

### Group 2 (assessed risk)

| Token system | Severity | Verdict |
|---|---|---|
| **LinkedIn** | **H** + M | Dev-bypass relies on env hygiene, not code-level prevention; production deployment with stray `NODE_ENV=dev` is hijackable to `DEV_BYPASS_SUB` (L23). Provider inference by sub-prefix is fragile (L24). Inconsistent error/state ordering vs Auth0 callback (L12). |
| **Auth0** | **H** ×3 | Runtime uses LinkedIn state store for Auth0 flow — dual state confusion surface (A11). Dead `getRoutes()` code returns Auth0 access token as JSON to the browser; one-line change reactivates it (A24). Bearer-path audience check skipped when snapshot's audience is null (A28). |
| **Registration** | **H** + M | `/complete` provisioning is non-atomic across multi-step flow; failure mid-sequence creates orphaned tenant the user can't claim (R20). Email-based invite-claim doesn't verify `email_verified` (R22). Slug collision returns ambiguous 409 (R21). |
| **WorkOS** | **H** (future, structural) | No SAML verification infrastructure exists; if WorkOS is implemented with SAML connections enabled, significant new threat surface (XML signature, canonicalization, replay) is added (W14). |

---

## Dimension 8 — Provider identification (cross-cutting)
[back to top ↩](#table-of-contents)

This isn't one of the original six named dimensions but it surfaced as a major cross-cutting concern in Run 5 and deserves its own row.

### Group 1 (what exists)

`inferProvider()` in `src/tenant/resolver.js` and an inline duplicate in `src/index.js` both map sub-string prefix to provider: `auth0|` or `google-oauth2|` → Auth0; `user_` → WorkOS. The `auth_provider` enum in `01-platform.sql` already accepts `'workos'` even though no WorkOS implementation exists. The runtime never reads the provider value carried by the authenticated session — it re-derives it from the sub prefix on every request.

### Group 2 (assessed risk)

**Severity: H (composite, live).** This single design choice produces findings in three runs: L24 (LinkedIn callback), A24 (Auth0 dual-state), W9 + W10 + W11 (WorkOS scaffolding). A custom Auth0 connection that issues `user_`-prefixed subs would route to the WorkOS lookup path; combined with R22 (no `email_verified` gate) and R1 (invites never expire), produces a wrong-tenant-assignment chain. The fix is one architectural change (pass authoritative provider through the session) closing 6+ findings simultaneously.

---

## Six high-leverage architectural changes (Run 5 prioritization)
[back to top ↩](#table-of-contents)

These are the changes where the engineering investment closes the most findings.

1. **Authoritative provider through session/registry** — closes L24, A24, W9, W10, W11. ~30 lines of code, low risk.
2. **Hash registration tokens at rest** — closes R13. ~20 lines in `platform-db.js` registration functions.
3. **Set `expires_at` on the registration-created owner invite** + gate resolver lookup + schedule `expireStaleRegistrations` — closes the highest-ranked chain (tenant takeover via domain re-registration). ~10 lines + a cron entry.
4. **Move both encryption secrets to a secrets manager with rotation** + add key-version byte to ciphertext format — closes A17, L17, L20. 2–3 focused days.
5. **Implement refresh-token usage** (or strip refresh tokens entirely) — closes L7, A8, A9, breaks consent-fatigue chain. A week for the proper fix; an afternoon for the subtractive version.
6. **Gate invite-claim on `email_verified === true`** — closes the middle of Chain 1, weakens W3. ~3 lines in `resolver.js`.

### If you only ship one thing

**Change 3.** It closes the highest-ranked attack chain (tenant takeover via domain re-registration), is the smallest in scope, has near-zero regression risk, and is the change most aligned with the userMemories' "Post Multi-Tenant User" pending security hardening list.

---

Ready for the next category — design, build, test, or deploy — on any of these.





---
Powered by [Claude Exporter](https://www.ai-chat-exporter.net)