# `.env` Property Audit — LinkedIn AI Content Agent 1.9.34

**Scope.** Every environment variable read anywhere in the 1.9.34 source you uploaded, ordered alphabetically. For each property: a functional description (what it controls), then one or more **bold header → code panel** pairs showing every place it is read.

**On line-number accuracy** — you've flagged before that line numbers drift. These were produced by `grep -n` / `awk` over the *actual extracted 1.9.34 files*, so every range below counts real lines in your source, **including comment and blank lines**. They are not estimated from a model snapshot.

**Three conventions used throughout:**

- `src/index.js` and `src_templates/index.js` are **identical line-for-line** (the template generates the runtime file). Panels cite `src/index.js`; the same line numbers apply to the template.
- Inline `// ◄ ...` markers are **my annotations**, not present in your source.
- **Six properties are read indirectly** and would be missed by a naive `process.env.NAME` grep: `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` (via `decEnv("…")`) and `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` (via `process.env[name]` over an `ENCRYPTED_VARS` array). They are included.

**Encryption-at-rest classification** (decrypted via `platform-secret.js`, AES-256-GCM + HKDF): `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PLATFORM_ADMIN_SUBS`, `PLATFORM_ADMIN_DB_ROLE`, `PLATFORM_ANTHROPIC_API_KEY`. Root key material (plaintext, never scrubbed): `ENCRYPTION_SECRET`. Session key (plaintext hex, validated): `SESSION_SECRET`. Everything else is plaintext non-secret config.

**Delta vs 1.9.33.** The 1.9.34 change is a post-status state-machine refactor — a new `src/services/post-status.js` (which reads **no** environment variables), `setPostScheduled` generalized to `transitionPostStatus`, and the `/api/posts/:id/schedule` route generalized to `/api/posts/:id/status`. It **adds no new environment variables and removes none**: the inventory is unchanged at **63 properties**. Only line numbers moved — the new `post-status.js` import shifted `AGENT_MODE`'s dead read in `database.js` (135 → 136) and all four `scheduler.js` reads (`MIN_HOURS_BETWEEN_POSTS` 42 → 43, `MAX_POSTS_PER_10_DAYS` 43 → 44, `MIN_MINUTES_BETWEEN_SCHEDULED_POSTS` 274 → 277, `PREFERRED_POST_HOUR` 334 → 348). Those panel headers are updated below; every code panel is otherwise byte-identical to 1.9.33.

**New in this revision.** Each section now carries a deep **If unset / missing** analysis directly beneath its code panel, stating the concrete effect of the variable being absent (or, for the encrypted vars, undecryptable). The pattern at a glance: every numeric/threshold var falls back to a validated default; every at-rest secret and every required connection var fails **closed**; a handful of URL/origin and mode vars fail **silently** in ways worth knowing.

A short **Audit findings summary** is at the very end.

---

## AGENT_MODE

Seeds the platform's default agent operating mode (`manual` vs automated) and is echoed in the startup banner. Default `"manual"`.

**Audit note —** its only data read (`database.js:136`) is in code the file itself marks `// UNREACHABLE CODE`, immediately after an unconditional `throw` inside the legacy `initDatabase()` stub. So `AGENT_MODE` has **no live behavioural effect**; the live agent mode is per-tenant in `agent_state` (Postgres). The single live use is the cosmetic banner line.

**`AGENT_MODE` · src/services/database.js · lines 132–138  (dead code — after an unconditional throw at line 87)**

```js
  // Initialize default agent state
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO agent_state (key, value) VALUES (?, ?)
  `);
  upsert.run("mode", process.env.AGENT_MODE || "manual");   // ◄ unreachable; see line 92 "// UNREACHABLE CODE"
  upsert.run("last_topic_id", "");
  upsert.run("paused", "false");
```

**`AGENT_MODE` · src/index.js · line 656  (startup banner — only live read)**

```js
║           Mode:  ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(0)}
```

**If unset / missing:** No effect. The only live read (the banner) falls back to `"manual"` and prints `MANUAL`; the `database.js` read is unreachable, and the real per-tenant mode lives in the Postgres `agent_state` table. An empty string behaves identically (falsy → `"manual"`).

---

## ALLOWED_ORIGINS

Comma-separated CORS allowlist. Split, trimmed, trailing slashes stripped, then merged with `AUTH0_PUBLIC_ORIGIN` and the resolved server origin into a default-deny allowlist.

**`ALLOWED_ORIGINS` · src/index.js · lines 100–105**

```js
  const normalizeOrigin = (s) => (s || "").trim().replace(/\/+$/, "");
  const allowedOrigins = [...new Set([
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map(normalizeOrigin),   // ◄
    normalizeOrigin(process.env.AUTH0_PUBLIC_ORIGIN),
    normalizeOrigin(getServerAddress().origin),
  ].filter(Boolean))];
```

**If unset / missing:** The explicit cross-origin contribution is empty, so the CORS allowlist reduces to just the normalized `AUTH0_PUBLIC_ORIGIN` plus the resolved server origin (the empty entry is dropped by `.filter(Boolean)`). CORS stays default-deny — nothing is opened — but any *legitimately separate* front-end origin (e.g. the CloudFront/S3 site calling the ALB API on a different host) is CORS-blocked until you add it here. Safe by default; a silent functional outage only for a genuinely cross-origin front end.

---

## ANTHROPIC_API_KEY_ENCRYPTED

**Legacy / vestigial.** Single-tenant era global Anthropic key (encrypted). In 1.9.34 keys are per-tenant BYOK, so this is **only deleted at boot** — never read. Safe to remove from `.env`.

**`ANTHROPIC_API_KEY_ENCRYPTED` · src/index.js · lines 580–584**

```js
  // STEP 3: Scrub no-longer-needed legacy secrets.
  // ENCRYPTION_SECRET is NOT scrubbed — the credential store reads
  // it on every credential access.
  delete process.env.ENCRYPTION_SALT;
  delete process.env.ANTHROPIC_API_KEY_ENCRYPTED;   // ◄ only operation on this var anywhere
```

**If unset / missing:** No effect whatsoever — the variable is only `delete`d at boot, and deleting an absent key is a no-op.

---

## ANTHROPIC_MODEL

Deployment-level Anthropic model override. Level 2 of a three-tier fallback: per-tenant `agent_state` → `ANTHROPIC_MODEL` → hardcoded `DEFAULT_MODEL` (`claude-haiku-4-5-20251001`).

**`ANTHROPIC_MODEL` · src/config/ai.js · lines 52–59**

```js
  // Level 2: deployment-level env override
  const envValue = process.env.ANTHROPIC_MODEL;   // ◄
  if (envValue && typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  // Level 3: hardcoded default
  return DEFAULT_MODEL;
```

**If unset / missing:** Tier 2 is skipped and resolution falls to the hardcoded `DEFAULT_MODEL` (`claude-haiku-4-5-20251001`); generation still works. A per-tenant `agent_state` model (tier 1) still wins where set, so unset only means "no deployment-wide model override."

---

## API_COOLDOWN_MS

Pause between consecutive Anthropic calls to stay under rate limits. Validated to a positive integer; default `10000` (10s). Replaces a former hardcoded 65s sized for free-tier keys.

**`API_COOLDOWN_MS` · src/config/research.js · lines 158–160**

```js
export function getCooldownMs() {
  const val = parseInt(process.env.API_COOLDOWN_MS, 10);   // ◄
  return val > 0 ? val : DEFAULT_API_COOLDOWN_MS;
}
```

**If unset / missing:** `parseInt(undefined)` → `NaN`, which fails the `>0` guard, so the validated default `10000` ms (10 s) is used. Benign. The only risk is on a heavily rate-limited key where 10 s is too short — a tuning concern, not a failure.

---

## APP_BASE_URL

Explicit public base URL (production). When set, `getServerAddress()` parses it for protocol/host/port instead of inferring from the bound socket; `DASHBOARD_PORT` is the fallback port when it is unset.

**`APP_BASE_URL` · src/services/server-address.js · lines 56–68**

```js
export function getServerAddress() {
  const fallbackPort = parseInt(process.env.DASHBOARD_PORT || "3001", 10);

  // ── Path 1: APP_BASE_URL is set (production / explicit config) ──
  const baseUrl = process.env.APP_BASE_URL;   // ◄
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const proto = parsed.protocol.replace(":", "");
      const host = parsed.hostname;
      const explicitPort = parsed.port
        ? parseInt(parsed.port, 10)
        : (proto === "https" ? 443 : 80);
```

**If unset / missing:** `getServerAddress()` takes Path 2 and *infers* the origin from the bound socket (using `DASHBOARD_PORT`, default 3001). In dev that yields a correct `localhost:3001` origin. In production behind the ALB/CloudFront the inferred origin is the internal bind address, not the public URL, so any other consumer of `getServerAddress()` would see an internal origin. CORS is not broken by this as long as `AUTH0_PUBLIC_ORIGIN` is set (it is added to the allowlist separately), but you should set `APP_BASE_URL` in production so derived URLs are canonical.

---

## APP_NAME

Product name interpolated into the registration invitation email subject/body. Default `"Content Agent"`.

**`APP_NAME` · src/routes/registration-api.js · lines 110–116**

```js
    const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
    const brandName = process.env.BRAND_NAME || "Content Agent";
    const appName = process.env.APP_NAME || "Content Agent";   // ◄
    const registerUrl = `${origin}/app/register#token=${invite.token}`;
// ...
    const emailSubject = `Your ${appName} Workspace`;
```

**If unset / missing:** Falls back to `"Content Agent"` in the invitation email subject/body. Purely cosmetic; registration is unaffected.

---

## AUTH0_AUDIENCE

OAuth audience claim requested from Auth0. Default `"https://linkedin-agent-api"`.

**`AUTH0_AUDIENCE` · src/auth/providers/auth0.js · lines 119–126**

```js
function getConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const domain = (process.env.AUTH0_DOMAIN || "").trim();
  const clientId = decEnv("AUTH0_CLIENT_ID");
  const clientSecret = decEnv("AUTH0_CLIENT_SECRET");
  const audience = (process.env.AUTH0_AUDIENCE || "https://linkedin-agent-api").trim();   // ◄
  const port = process.env.DASHBOARD_PORT || "3001";
```

**If unset / missing:** Falls back to `"https://linkedin-agent-api"`. This is benign **only if** that string equals your Auth0 API identifier. If your Auth0 API uses a different identifier, tokens are issued for the wrong `aud`, JWT audience validation fails, and every Auth0 login is rejected — an auth outage, not a crash. Treat the default as a value that must match your Auth0 tenant configuration.

---

## AUTH0_CLIENT_ID

**Encrypted at rest. Read indirectly via `decEnv("AUTH0_CLIENT_ID")`** (not `process.env.AUTH0_CLIENT_ID`), which decrypts with the platform secret and memo-caches the result; an undecryptable value yields `""` (fail-soft, then `init()` reports config missing).

**`AUTH0_CLIENT_ID` · src/auth/providers/auth0.js · line 122  (call site)**

```js
  const clientId = decEnv("AUTH0_CLIENT_ID");   // ◄ indirect read
```

**`AUTH0_CLIENT_ID` · src/auth/providers/auth0.js · lines 105–117  (`decEnv` resolver — shared by both Auth0 secrets)**

```js
function decEnv(name) {
  const cipher = (process.env[name] || "").trim();   // ◄ dynamic env lookup by name
  if (!cipher) return "";
  if (_decCache.has(cipher)) return _decCache.get(cipher);
  let plain = "";
  try {
    plain = decryptPlatformSecret(cipher);
  } catch {
    plain = "";                                       // ◄ fail-soft on bad ciphertext
  }
  _decCache.set(cipher, plain);
  return plain;
}
```

**If unset / missing:** `process.env[name]` is `undefined` → `decEnv` returns `""` (fail-soft). `getConfig()` then has an empty client ID, `init()` reports the Auth0 provider as not configured, and Auth0 login is unavailable. Fail-soft at the decrypt layer, fail-closed at the provider layer — no crash, but if Auth0 is your only provider, no one can log in.

---

## AUTH0_CLIENT_SECRET

**Encrypted at rest. Read indirectly via `decEnv("AUTH0_CLIENT_SECRET")`** — same resolver and fail-soft behaviour as `AUTH0_CLIENT_ID` (resolver shown above).

**`AUTH0_CLIENT_SECRET` · src/auth/providers/auth0.js · line 123  (call site)**

```js
  const clientSecret = decEnv("AUTH0_CLIENT_SECRET");   // ◄ indirect read
```

**If unset / missing:** Same path as the client ID — `decEnv` yields `""`, the provider is marked unconfigured, and the server-side code-for-token exchange cannot authenticate the client, so Auth0 login fails at the callback. Fail-soft decrypt, fail-closed provider; no crash.

---

## AUTH0_DOMAIN

Auth0 tenant domain. Trimmed, then any accidental scheme/trailing slash stripped before use in issuer/JWKS/authorize URLs. Empty default (auth init reports it missing rather than crashing).

**`AUTH0_DOMAIN` · src/auth/providers/auth0.js · lines 121 and 139–140**

```js
  const domain = (process.env.AUTH0_DOMAIN || "").trim();          // ◄ line 121
  // ...
  // Normalize domain — strip protocol if accidentally included
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");   // line 140
```

**If unset / missing:** Resolves to `""`, so the issuer/JWKS/authorize URLs cannot be built and `init()` reports the provider missing. The app still boots; Auth0 login is simply unavailable (fail-closed, no crash).

---

## AUTH0_LOGOUT_URI

Post-logout redirect target. When unset, derived from the public origin (`${origin}/`); empty when origin is also empty in production (fail-loud).

**`AUTH0_LOGOUT_URI` · src/auth/providers/auth0.js · lines 133–137**

```js
  // Explicit AUTH0_REDIRECT_URI / AUTH0_LOGOUT_URI override the origin-derived
  // values when set; otherwise they are built from the origin.
  const redirectUri = (process.env.AUTH0_REDIRECT_URI || (origin ? `${origin}/auth/callback` : "")).trim();
  const logoutUri   = (process.env.AUTH0_LOGOUT_URI   || (origin ? `${origin}/` : "")).trim();   // ◄
  const scopes = (process.env.AUTH0_SCOPES || "openid profile email").trim();
```

**If unset / missing:** Derived from the public origin as `${origin}/`. Benign as long as the origin resolves. If the origin is *also* empty (production with `AUTH0_PUBLIC_ORIGIN` unset), the logout URI becomes `""` and `init()` fails loud by design. So unset alone is fine — it only matters jointly with a missing origin.

---

## AUTH0_PUBLIC_ORIGIN

The public origin users load the app from — source of truth for redirect/logout URIs **and** seeds the CORS allowlist. Required in production (empty default forces a loud failure rather than a localhost leak).

**`AUTH0_PUBLIC_ORIGIN` · src/auth/providers/auth0.js · lines 127–131**

```js
  // Public origin: required in production; localhost is a dev-only default.
  // When unset in production, origin (and the URIs below) resolve to "" so
  // init() can report them missing and fail loud rather than crash.
  const origin = (process.env.AUTH0_PUBLIC_ORIGIN
    || (isProd ? "" : `http://localhost:${port}`)).trim();   // ◄
```

**`AUTH0_PUBLIC_ORIGIN` · src/index.js · line 103  (CORS allowlist seed)**

```js
    normalizeOrigin(process.env.AUTH0_PUBLIC_ORIGIN),   // ◄ keeps CORS aligned with login origin
```

**If unset / missing:** In dev it defaults to `http://localhost:${DASHBOARD_PORT}` and everything works. In **production** (`isProd`) it resolves to `""`, which cascades the redirect/logout URIs to empty and makes `init()` **fail loud** — intentional, to prevent a localhost value leaking into production. It is also dropped from the CORS allowlist when empty. Net: a required production variable whose absence is caught loudly rather than silently.

---

## AUTH0_REDIRECT_URI

OAuth callback URL. Overrides the origin-derived `${origin}/auth/callback` when set (panel shown under `AUTH0_LOGOUT_URI`, line 135).

**`AUTH0_REDIRECT_URI` · src/auth/providers/auth0.js · line 135**

```js
  const redirectUri = (process.env.AUTH0_REDIRECT_URI || (origin ? `${origin}/auth/callback` : "")).trim();   // ◄
```

**If unset / missing:** Derived as `${origin}/auth/callback`. Benign provided the origin resolves *and* the derived URL is registered as an Allowed Callback URL in Auth0. If the origin is empty (production without `AUTH0_PUBLIC_ORIGIN`) it becomes `""` and `init()` fails loud. Unset alone is acceptable; the derived value must match Auth0's configuration.

---

## AUTH0_SCOPES

OAuth scopes requested at login. Default `"openid profile email"`.

**`AUTH0_SCOPES` · src/auth/providers/auth0.js · line 137**

```js
  const scopes = (process.env.AUTH0_SCOPES || "openid profile email").trim();   // ◄
```

**If unset / missing:** Falls back to `"openid profile email"` — the standard OIDC scopes. Benign; only matters if you require additional scopes.

---

## AUTH_CALLBACK_URL

Callback path for the **mock** auth provider only (dev/test). Default `"/auth/mock/callback"`.

**`AUTH_CALLBACK_URL` · src/auth/providers/mock.js · lines 47–51**

```js
    router.get("/auth/mock/login", (req, res) => {
      const state = req.query.state || "";
      const code = crypto.randomBytes(16).toString("hex");
      const callbackUrl = `${process.env.AUTH_CALLBACK_URL || "/auth/mock/callback"}?code=${code}&state=${state}`;   // ◄
      res.redirect(callbackUrl);
    });
```

**If unset / missing:** Falls back to `/auth/mock/callback`. This affects the **mock** provider only, which is hard-blocked in production regardless, so the practical impact is nil outside dev/test.

---

## BATCH_PUBLISH_INTERVAL_MINUTES

Batch-publisher cadence in minutes, rendered as a `*/N * * * *` cron. Clamped to 1–59; invalid/unset falls back to 15 and logs loudly (never silently picks an odd cadence).

**`BATCH_PUBLISH_INTERVAL_MINUTES` · src/services/batch-publisher.js · lines 51–61**

```js
function resolveIntervalMinutes() {
  const raw = process.env.BATCH_PUBLISH_INTERVAL_MINUTES;   // ◄
  const n = parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < 1 || n > 59) {
    if (raw !== undefined && String(raw).trim() !== "") {
      platformLog("warn", "batch_publish_interval_invalid", { rejected: String(raw).slice(0, 20), using: 15 });
    }
    return 15;
  }
  return n;
}
```

**If unset / missing:** `raw` is `undefined` → coerced to `""` → `NaN` → returns `15`, and the `batch_publish_interval_invalid` warning is **skipped** (it fires only for a non-empty bad value). The batch publisher runs every 15 minutes. Benign, no log noise.

---

## BATCH_PUBLISH_MAX_PER_RUN

Upper bound on posts published per tenant per run — bounds work and LinkedIn call rate after a backlog. Clamped to 1–200; default 25.

**`BATCH_PUBLISH_MAX_PER_RUN` · src/services/batch-publisher.js · lines 66–69**

```js
function resolveMaxPerRun() {
  const n = parseInt(process.env.BATCH_PUBLISH_MAX_PER_RUN ?? "", 10);   // ◄
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 25;
}
```

**If unset / missing:** `NaN` fails the 1–200 range check, so the default `25` is used — up to 25 posts per tenant per run. Benign.

---

## BRAND_NAME

Brand string for the registration email (Phase-1 single-brand-from-`.env` per your branding backlog). Default `"Content Agent"`.

**`BRAND_NAME` · src/routes/registration-api.js · line 111**

```js
    const brandName = process.env.BRAND_NAME || "Content Agent";   // ◄
```

**If unset / missing:** Falls back to `"Content Agent"` in the registration email. Cosmetic.

---

## DASHBOARD_FEED_LIMIT

Max feeds shown in the Research Monitor panel. Default 8.

**Audit note —** there are **two read paths and they disagree on validation.** The documented getter `getDashboardFeedLimit()` validates `> 0` — but it is **never called** anywhere. The live read is the inline `parseInt(...) || 8` in the status route, which skips that validation (and treats `0` as falsy → 8). Recommend routing the live read through the getter so there's one validated source.

**`DASHBOARD_FEED_LIMIT` · src/config/research.js · lines 51–58  (validating getter — currently unused)**

```js
/**
 * Dashboard feed limit — max feeds shown in the Research
 * Monitor panel. Env: DASHBOARD_FEED_LIMIT. Default: 8.
 */
export function getDashboardFeedLimit() {
  const val = parseInt(process.env.DASHBOARD_FEED_LIMIT, 10);   // ◄ never invoked
  return val > 0 ? val : DEFAULT_DASHBOARD_FEED_LIMIT;
}
```

**`DASHBOARD_FEED_LIMIT` · src/routes/api.js · line 204  (live read — bypasses the getter)**

```js
      feedLimit: parseInt(process.env.DASHBOARD_FEED_LIMIT) || 8,   // ◄ no radix, no >0 guard
```

**If unset / missing:** On the live path, `parseInt(undefined)` → `NaN` → `NaN || 8` → `8`; the Research Monitor shows 8 feeds. Benign. Note the live read's `|| 8` shape means an explicit `0` (or any non-numeric) also collapses to 8 — you cannot set it to zero — but unset is handled cleanly.

---

## DASHBOARD_PORT

HTTP listen port and the fallback port for origin construction. Default `3001`.

**`DASHBOARD_PORT` · src/index.js · line 648  (server listen)**

```js
  const PORT = process.env.DASHBOARD_PORT || 3001;   // ◄
```

**`DASHBOARD_PORT` · src/services/server-address.js · line 57  (fallback port for origin)**

```js
  const fallbackPort = parseInt(process.env.DASHBOARD_PORT || "3001", 10);   // ◄
```

**`DASHBOARD_PORT` · src/auth/providers/auth0.js · line 125  (dev localhost origin)**

```js
  const port = process.env.DASHBOARD_PORT || "3001";   // ◄ used in http://localhost:${port}
```

**If unset / missing:** The server listens on `3001`, the origin-fallback port is `3001`, and the dev localhost origin uses `3001`. Benign **only if** your process manager / ALB target group / reverse proxy expects 3001. If your proxy forwards to a different port and this is unset, the app binds 3001 and the proxy can't reach it — a self-inflicted outage. Must align with the deployment's expected port.

---

## DEV_BYPASS_ORIGINS

Half of the two-condition dev auth bypass: bypass is active **only** when `NODE_ENV === "dev"` *and* this is a non-empty origin allowlist. The request's effective origin must appear in it. Unset ⇒ auth enforced (fail-closed).

**`DEV_BYPASS_ORIGINS` · src/auth/middleware.js · lines 49–73  (`isDevBypass`)**

```js
function isDevBypass(req) {
  if (process.env.NODE_ENV !== 'dev') return false;            // ◄ condition 1

  const bypassOrigins = process.env.DEV_BYPASS_ORIGINS;        // ◄ condition 2
  if (!bypassOrigins) return false;

  const allowed = bypassOrigins.split(',').map(o => o.trim()).filter(Boolean);
  if (allowed.length === 0) return false;

  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) return true;

  if (!origin) {
    const proto = req.protocol || 'http';
    const host = req.headers.host;
    if (host) {
      const effective = `${proto}://${host}`;
      if (allowed.includes(effective)) return true;
    }
  }
  return false;
}
```

**`DEV_BYPASS_ORIGINS` · src/index.js · lines 304–305 and 420–421  (mode-active checks: LinkedIn callback + homepage)**

```js
      const devBypassActive = process.env.NODE_ENV === "dev"
        && !!process.env.DEV_BYPASS_ORIGINS;   // ◄ identical two-condition gate, no origin check here
```

**`DEV_BYPASS_ORIGINS` · src/index.js · line 662  (startup banner)**

```js
║           ${process.env.DEV_BYPASS_ORIGINS}
```

**Audit note —** banner line 662 prints the raw value with no label. When unset, a template literal renders the string `"undefined"` into the banner (`║           undefined`). Cosmetic only, but it shows in production logs. Suggest `${process.env.DEV_BYPASS_ORIGINS || ""}` plus a label.

**If unset / missing:** The dev auth bypass is **off** — `if (!bypassOrigins) return false` short-circuits, and normal authentication is enforced. This is the secure default; the bypass is only ever reachable under `NODE_ENV=dev` *and* a non-empty allowlist. (Unrelated cosmetic: the unlabelled banner prints the literal `undefined`, noted above.)

---

## DEV_BYPASS_SUB

The synthetic `sub` (a real membership `auth_sub`) injected as `req.user` when dev bypass is active, so the tenant resolver can load a workspace without a login. Unset ⇒ no synthetic identity (tenant routes 403).

**`DEV_BYPASS_SUB` · src/auth/middleware.js · lines 93–101  (`syntheticDevUser`)**

```js
function syntheticDevUser() {
  const sub = process.env.DEV_BYPASS_SUB;   // ◄
  if (!sub || typeof sub !== 'string' || sub.trim().length === 0) return null;
  return {
    sub: sub.trim(),
    email: null,
    name: 'Dev Bypass User',
    authMethod: 'dev-bypass'
```

**`DEV_BYPASS_SUB` · src/index.js · lines 306–308  (LinkedIn OAuth callback identity)**

```js
      const bypassSub = process.env.DEV_BYPASS_SUB;   // ◄
      if (devBypassActive && bypassSub && bypassSub.trim().length > 0) {
        userSub = bypassSub.trim();
```

**`DEV_BYPASS_SUB` · src/index.js · lines 435–437  (homepage greeting identity)**

```js
      const sub = process.env.DEV_BYPASS_SUB;   // ◄
      if (sub && sub.trim().length > 0) {
        user = { name: "Dev Bypass User", email: null, sub: sub.trim() };
```

**If unset / missing:** No synthetic identity is produced — `syntheticDevUser()` returns `null`, and the OAuth-callback and homepage paths skip their bypass branches. Even if bypass origins were set, there is no identity to inject, so the tenant resolver has no `req.user` and protected routes return 403. Fail-closed.

---

## DOMAIN_MATCH_THRESHOLD

Minimum tag-overlap score for a feed to qualify as a domain match for a topic (Feeds Manager v2 tier). `NaN` ⇒ default `0.4`; otherwise clamped to `[0.0, 1.0]`.

**`DOMAIN_MATCH_THRESHOLD` · src/config/research.js · lines 112–116**

```js
export function getDomainMatchThreshold() {
  const val = parseFloat(process.env.DOMAIN_MATCH_THRESHOLD);   // ◄
  if (isNaN(val)) return DEFAULT_DOMAIN_MATCH_THRESHOLD;
  return Math.max(0.0, Math.min(1.0, val));
}
```

**If unset / missing:** `parseFloat(undefined)` → `NaN` → default `0.4`. A feed needs ≥ 0.4 tag-overlap to match a topic in the v2 matching tier. Benign, and only consulted when `FEEDS_MANAGER_VERSION` resolves to 2.

---

## ENCRYPTION_SALT

**Legacy / vestigial.** No live read — only deleted at boot. The header comment confirms it is removable. Safe to delete from `.env`.

**`ENCRYPTION_SALT` · src/index.js · line 583**

```js
  delete process.env.ENCRYPTION_SALT;   // ◄ only operation on this var anywhere
```

**If unset / missing:** No effect — only `delete`d at boot; deleting an absent variable is a no-op.

---

## ENCRYPTION_SECRET

**Root key material.** HKDF input keying material (IKM) for *every* at-rest decryption in the platform: platform secrets, per-tenant credentials, the prompt vault, action-token signing, and registration-scoped keys. Deliberately **not scrubbed** from the environment (unlike the other secrets) because it is needed on every credential access. Missing ⇒ hard failure in each consumer (fail-closed).

**`ENCRYPTION_SECRET` · src/services/platform-secret.js · lines 35–49  (platform-secret key derivation — the shared decryptor)**

```js
function deriveKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_SECRET;   // ◄
  if (!secret || secret.length === 0) {
    throw new Error("ENCRYPTION_SECRET is not set — platform secret cannot be decrypted");
  }
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}
```

**`ENCRYPTION_SECRET` · src/tenant/credential-store.js · lines 51–64  (per-tenant key; tenantId as HKDF salt)**

```js
function deriveTenantKey(tenantId) {
  if (keyCache.has(tenantId)) return keyCache.get(tenantId);
  const secret = process.env.ENCRYPTION_SECRET;   // ◄
  if (!secret) throw new Error("ENCRYPTION_SECRET not set");
  const derived = crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(tenantId, "utf8"),   // ◄ per-tenant domain separation
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES
  );
  const key = Buffer.from(derived);
  keyCache.set(tenantId, key);
  return key;
}
```

**`ENCRYPTION_SECRET` · src/services/prompt-vault.js · lines 43–48  (vault key)**

```js
function deriveKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_SECRET;   // ◄
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET is not set — prompt vault cannot operate");
  }
```

**`ENCRYPTION_SECRET` · src/services/prompt-actions.js · lines 67–72  (HMAC signing key for action tokens; `var`-style file)**

```js
function getSigningKey() {
  if (signingKey) return signingKey;
  var secret = process.env.ENCRYPTION_SECRET;   // ◄
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET is not set — action tokens cannot be signed");
  }
```

**`ENCRYPTION_SECRET` · src/tenant/platform-db.js · lines 211–214  (registration-scoped PBKDF2 key)**

```js
function deriveRegKey(registrationId) {
  const secret = process.env.ENCRYPTION_SECRET;   // ◄
  if (!secret) throw new Error("ENCRYPTION_SECRET is required");
  return pbkdf2Sync(secret, `reg:${registrationId}`, 100000, 32, "sha512");
}
```

**`ENCRYPTION_SECRET` · encrypt-platform-key.js · lines 61–66  (CLI loads it to *encrypt* new secrets)**

```js
  const secret = readEnvVar(envPath, "ENCRYPTION_SECRET");
  if (!secret) {
    console.error("ENCRYPTION_SECRET not found in " + envPath);
    process.exit(1);
  }
  process.env.ENCRYPTION_SECRET = secret;   // ◄ sets it so platform-secret.js can derive the key
```

**If unset / missing:** **Total boot failure, fail-closed, in every consumer.** Each `deriveKey`/signing function throws on `!secret`. Critically, the Postgres connection variables are decrypted via `decryptPlatformSecret` → `deriveKey` at pool load, so an absent `ENCRYPTION_SECRET` means the DB pool cannot initialize and **the application cannot start** — credentials, the prompt vault, action-token signing, and registration-key derivation all throw as well. There is no fallback by design (this is root key material). Note too that it is deliberately *not* scrubbed from `process.env`, so unlike the other secrets it lingers in `/proc/<pid>/environ` — the documented tradeoff that the planned move to AWS Secrets Manager is meant to close.

---

## FEEDS_MANAGER_VERSION

Selects Feeds-Manager matching tiers: `1` = topics + catchall (v1); `2` = adds domain-overlap matching. Per-tenant `agent_state` wins; falls back to this env (must be `1` or `2`), then default `1`.

**`FEEDS_MANAGER_VERSION` · src/config/research.js · lines 86–98**

```js
export async function getFeedsManagerVersion() {
  try {
    const dbVal = await getAgentState("feeds_manager_version");
    if (dbVal) {
      const parsed = parseInt(dbVal, 10);
      if (parsed === 1 || parsed === 2) return parsed;
    }
  } catch {
    // Outside withTenant or DB error — fall through to .env
  }
  const envVal = parseInt(process.env.FEEDS_MANAGER_VERSION, 10);   // ◄
  return (envVal === 1 || envVal === 2) ? envVal : DEFAULT_FEEDS_MANAGER_VERSION;
}
```

**If unset / missing:** `parseInt(undefined)` → `NaN`, which is neither 1 nor 2, so the default `1` (topics + catchall, no domain-overlap tier) is used. Benign; a per-tenant `agent_state` value can still select tier 2.

---

## FEED_POLL_CRON

Cron schedule for the recurring feed poll across all tenants. Validated (5-field numeric syntax); invalid ⇒ logs loudly and continues hourly rather than silently stopping.

**`FEED_POLL_CRON` · src/services/news-monitor.js · lines 643–651**

```js
  // Recurring poll for all tenants. Schedule is FEED_POLL_CRON
  // (validated; numeric 5-field syntax) with hourly as the safe
  // default — an invalid value logs loudly and polling continues
  // hourly rather than silently stopping.
  const sched = resolvePollSchedule(process.env.FEED_POLL_CRON);   // ◄
  if (!sched.valid) {
    console.error(`[news-monitor] FEED_POLL_CRON "${sched.rejected}" is not a supported cron expression — using default "${sched.expression}" (hourly)`);
    platformLog("error", "feed_poll_cron_invalid", { rejected: sched.rejected, using: sched.expression });
  }
```

**If unset / missing:** `resolvePollSchedule(undefined)` returns `{ valid: true, source: "default" }`, so the hourly default schedule is used and **no** error is logged (the invalid-cron log path fires only for a non-empty malformed value). Feeds are polled hourly across all tenants. Benign.

---

## LINKEDIN_CLIENT_ID

**Encrypted at rest.** LinkedIn OAuth client ID; decrypted lazily and memo-cached on ciphertext. Throws if unset (fail-closed) — the OAuth flow cannot start without it.

**`LINKEDIN_CLIENT_ID` · src/services/linkedin-api.js · lines 29–39**

```js
function getClientId() {
  const cipher = process.env.LINKEDIN_CLIENT_ID;   // ◄
  if (!cipher || cipher.trim().length === 0) {
    throw new Error("LINKEDIN_CLIENT_ID is not set");
  }
  if (cipher === _clientIdCipher) return _clientIdPlain;
  const plain = decryptPlatformSecret(cipher.trim());
  _clientIdCipher = cipher;
  _clientIdPlain = plain;
  return plain;
}
```

**If unset / missing:** `getClientId()` throws `"LINKEDIN_CLIENT_ID is not set"` the first time the OAuth flow needs it (connect/authorize). The app still boots and unrelated features work, but **LinkedIn connect and publish are broken** until it is set. Fail-closed, lazy.

---

## LINKEDIN_CLIENT_SECRET

**Encrypted at rest.** LinkedIn OAuth client secret; same lazy-decrypt + cache + fail-closed pattern as the client ID. Used only in the server-side token exchange.

**`LINKEDIN_CLIENT_SECRET` · src/services/linkedin-api.js · lines 41–51**

```js
function getClientSecret() {
  const cipher = process.env.LINKEDIN_CLIENT_SECRET;   // ◄
  if (!cipher || cipher.trim().length === 0) {
    throw new Error("LINKEDIN_CLIENT_SECRET is not set");
  }
  if (cipher === _clientSecretCipher) return _clientSecretPlain;
  const plain = decryptPlatformSecret(cipher.trim());
  _clientSecretCipher = cipher;
  _clientSecretPlain = plain;
  return plain;
}
```

**If unset / missing:** `getClientSecret()` throws on the same pattern; the code-for-token exchange cannot run, so connecting a LinkedIn account fails at the callback step. App boots; only LinkedIn auth/publish breaks. Fail-closed, lazy.

---

## LINKEDIN_IMAGE_MAX_BYTES

Max image upload size when publishing in image-posting mode. Positive-int validated; default `10 * 1024 * 1024` (10 MB).

**`LINKEDIN_IMAGE_MAX_BYTES` · src/services/linkedin-publisher.js · lines 80–83**

```js
function getImageMaxBytes() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_MAX_BYTES, 10);   // ◄
  return val > 0 ? val : 10 * 1024 * 1024; // 10 MB default
}
```

**If unset / missing:** `NaN` fails the `>0` guard → default `10 * 1024 * 1024` (10 MB). Benign; only consulted in image-posting mode.

---

## LINKEDIN_IMAGE_POLL_INTERVAL_MS

Delay between polls while waiting for LinkedIn to finish processing an uploaded image. Default `2000` (2s).

**`LINKEDIN_IMAGE_POLL_INTERVAL_MS` · src/services/linkedin-publisher.js · lines 90–93**

```js
function getImagePollIntervalMs() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS, 10);   // ◄
  return val > 0 ? val : 2000; // 2 seconds
}
```

**If unset / missing:** Defaults to `2000` ms between image-processing polls. Benign.

---

## LINKEDIN_IMAGE_POLL_MAX

Max poll attempts for image-processing completion before giving up. Default `10`.

**`LINKEDIN_IMAGE_POLL_MAX` · src/services/linkedin-publisher.js · lines 85–88**

```js
function getImagePollMaxAttempts() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_POLL_MAX, 10);   // ◄
  return val > 0 ? val : 10;
}
```

**If unset / missing:** Defaults to `10` attempts. Benign; at the default 2 s interval that is ~20 s of processing wait — only a concern for unusually slow/large image uploads, which is a tuning matter.

---

## LINKEDIN_PUBLISH_MODE

Selects the publish path: `text-posting` (default) or `image-posting`. Backward-compat aliases: `rest` → image, `legacy` → text.

**`LINKEDIN_PUBLISH_MODE` · src/services/linkedin-publisher.js · lines 53–58**

```js
function getPublishMode() {
  const mode = (process.env.LINKEDIN_PUBLISH_MODE || "text-posting").toLowerCase();   // ◄
  // Backward compat: "rest" → "image-posting", "legacy" → "text-posting"
  if (mode === "image-posting" || mode === "rest") return "image-posting";
  return "text-posting";
}
```

**If unset / missing:** Defaults to `text-posting`. Benign, but note the consequence: to publish images you must explicitly set `image-posting` (or the `rest` alias) — leaving this unset silently restricts you to text-only posts.

---

## LINKEDIN_PUBLISH_TARGET

Which LinkedIn identity authors posts: `personal` (default, `linkedin_person_urn`) or `organization` (`linkedin_org_urn`). Switch is a `.env`-change + restart; both URNs coexist, no re-auth.

**`LINKEDIN_PUBLISH_TARGET` · src/services/linkedin-publisher.js · lines 60–69**

```js
function getPublishTarget() {
  // Controls which LinkedIn identity is used as the post author.
  //   personal     — urn:li:person:{id} from linkedin_person_urn (default)
  //   organization — urn:li:organization:{id} from linkedin_org_urn
  //
  // Switching is a .env change + restart. Both URNs coexist in
  // the credentials table — no re-authentication needed.
  const target = (process.env.LINKEDIN_PUBLISH_TARGET || "personal").toLowerCase();   // ◄
  return target === "organization" ? "organization" : "personal";
}
```

**If unset / missing:** Defaults to `personal`, so posts are authored as the connected **person** URN. If you intended to publish to an **organization** page and forget this, posts are silently routed to the personal profile instead — a content-routing mistake that produces no error. Worth an explicit value whenever org posting is intended.

---

## LINKEDIN_REDIRECT_URI

OAuth `redirect_uri` sent in both the authorize request and the token exchange. Public value (not a secret), used as-is.

**Audit note —** no presence guard: if unset, `redirect_uri: undefined` is sent in the URL/body. Minor, but a one-line guard at startup (this is a public config value, not a secret) would fail fast instead of producing an opaque LinkedIn error.

**`LINKEDIN_REDIRECT_URI` · src/services/linkedin-api.js · lines 58–63  (authorize)**

```js
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,   // ◄ no guard
    scope: scopes.join(" "),
    state: state || generateState()
  });
```

**`LINKEDIN_REDIRECT_URI` · src/services/linkedin-api.js · lines 77–82  (token exchange)**

```js
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,   // ◄ must byte-match the authorize value
        client_id: getClientId(),
        client_secret: getClientSecret()
      }),
```

**If unset / missing:** There is **no guard**, so `redirect_uri` is `undefined` and `URLSearchParams` serializes it as the literal string `"undefined"` in both the authorize URL and the token-exchange body. The two legs "match each other" but match nothing registered, so LinkedIn rejects the flow with an opaque `redirect_uri` error and no fast-fail. This is the open recommendation: add a one-line startup presence check (it is public config, safe to log).

---

## LINKEDIN_TOKEN_CHECK_MINUTES

TTL (minutes) of the per-tenant LinkedIn token-validity cache, converted to ms. Default `10`.

**`LINKEDIN_TOKEN_CHECK_MINUTES` · src/services/linkedin-api.js · lines 218–220**

```js
function getTokenCacheTtl() {
  return parseInt(process.env.LINKEDIN_TOKEN_CHECK_MINUTES || "10", 10) * 60 * 1000;   // ◄
}
```

**If unset / missing:** Defaults to `10` minutes of token-validity caching. Benign.

---

## LINKEDIN_VERSION

LinkedIn REST API date-based version header. Must match the approved product version; LinkedIn sunsets versions ~12 months, so this is `.env`-tunable without a code deploy. Default `"202509"`.

**`LINKEDIN_VERSION` · src/services/linkedin-publisher.js · lines 71–78**

```js
function getLinkedInVersion() {
  // LinkedIn REST API date-based version. Must match your approved
  // product version. Check your app's Products tab at
  // developer.linkedin.com for the current version.
  // LinkedIn sunsets versions after ~12 months — update via .env
  // without a code deployment when your product version changes.
  return process.env.LINKEDIN_VERSION || "202509";   // ◄
}
```

**If unset / missing:** Defaults to `"202509"`. Benign **while** LinkedIn still supports that version. Because LinkedIn sunsets versions after ~12 months, a stale default eventually causes API errors — so the risk is on the hardcoded default aging out, not on "unset" per se. Track LinkedIn's current supported version and set this when it changes.

---

## LLM_TRACE

Opt-in observability switch. When truthy (via `traceEnabled(...)`), each of the four LLM stages additionally emits a `llm_payload_*` **DEBUG** dump containing the fully assembled prompt; otherwise only metadata `llm_request_*` INFO markers are logged. Per your notes, the redaction/size-cap guard for these dumps is a deferred Phase-2 item.

**`LLM_TRACE` · src/services/content-generator.js · lines 278–284  (stage 3 — main post generation)**

```js
    platformLog("info", "llm_request_main_post_generation",
      buildLlmRequestInfo("main_post_generation", "3 of 4", requestParams,
        { cycleId, topicId: topic.slug, angle, corroborationSkipped: skipCorroboration }));
    if (traceEnabled(process.env.LLM_TRACE)) {   // ◄
      platformLog("debug", "llm_payload_main_post_generation",
        buildLlmPayloadDebug("main_post_generation", requestParams, cycleId));
    }
```

**`LLM_TRACE` · src/services/research.js · lines 111 and 232  (stage 1 web-search; later research stage)** — identical `if (traceEnabled(process.env.LLM_TRACE)) { … llm_payload_* debug … }` guard.

**`LLM_TRACE` · src/services/content-generator.js · lines 415 and 489  (stage 4 quality-check; final stage)** — same guard pattern.

**If unset / missing:** `traceEnabled(undefined)` → `false`, so the `llm_payload_*` DEBUG dumps are disabled and only metadata `llm_request_*` INFO markers are logged. This is both the intended default and the safer one — since the redaction/size-cap guard for those dumps is still deferred, keeping them off by default avoids writing fully assembled prompts to logs.

---

## MAX_AGE_DAYS

Research window — articles older than this (days) are excluded from content generation. Positive-int validated; default `20`.

**`MAX_AGE_DAYS` · src/config/research.js · lines 27–30**

```js
export function getMaxAgeDays() {
  const val = parseInt(process.env.MAX_AGE_DAYS, 10);   // ◄
  return val > 0 ? val : DEFAULT_MAX_AGE_DAYS;
}
```

**If unset / missing:** `NaN` fails `>0` → default `20` days. Articles older than 20 days are excluded from generation. Benign.

---

## MAX_AGE_DAYS_PRUNE

Pruning window — `feed_articles` links older than this (days) are deleted during polling. Positive-int validated; default `60`.

**`MAX_AGE_DAYS_PRUNE` · src/config/research.js · lines 36–39**

```js
export function getMaxAgeDaysPrune() {
  const val = parseInt(process.env.MAX_AGE_DAYS_PRUNE, 10);   // ◄
  return val > 0 ? val : DEFAULT_MAX_AGE_DAYS_PRUNE;
}
```

**If unset / missing:** Defaults to `60` days; `feed_articles` links older than 60 days are pruned during polling. Benign; leaving it unset just means standard 60-day retention.

---

## MAX_POSTS_PER_10_DAYS

Cadence ceiling — posts allowed per rolling 10-day window. Default `4`.

**Audit note —** two independent reads with duplicated parse logic (a small DRY issue, same shape as `DASHBOARD_FEED_LIMIT`): the scheduler's `MAX_PER_10_DAYS()` getter and an inline re-read in the status route. Both currently agree (`|| "4"`), so no behavioural divergence today — but two sources of truth tend to drift.

**`MAX_POSTS_PER_10_DAYS` · src/services/scheduler.js · line 44  (cadence enforcement)**

```js
const MAX_PER_10_DAYS = () => parseInt(process.env.MAX_POSTS_PER_10_DAYS || "4", 10);   // ◄
```

**`MAX_POSTS_PER_10_DAYS` · src/routes/api.js · line 115  (status payload — re-read)**

```js
    const maxPostsPer10Days = parseInt(process.env.MAX_POSTS_PER_10_DAYS || "4", 10);   // ◄ duplicate parse
```

**If unset / missing:** Both reads use `|| "4"`, so the cadence ceiling defaults to 4 posts per rolling 10-day window with no divergence between the scheduler getter and the status-route re-read. Benign.

---

## MAX_RESEARCH_ARTICLES

Max articles returned for content generation — directly bounds AI prompt size and token cost. Positive-int validated; default `30`.

**`MAX_RESEARCH_ARTICLES` · src/config/research.js · lines 46–49**

```js
export function getMaxResearchArticles() {
  const val = parseInt(process.env.MAX_RESEARCH_ARTICLES, 10);   // ◄
  return val > 0 ? val : DEFAULT_MAX_RESEARCH_ARTICLES;
}
```

**If unset / missing:** `NaN` fails `>0` → default `30`. The research set is capped at 30 articles, bounding prompt size and token cost. Benign.

---

## METRIC_FIDELITY_STRICT

Opt-in (`"1"`) strict number-policing in generated posts: when on, every number in the body must trace to a verified metric or appear in the research block, else generation is rejected. Off by default because on-by-default would block legitimate research-driven numbers (years, counts, cited stats). Token-integrity checks always run regardless of this flag.

**`METRIC_FIDELITY_STRICT` · src/services/content-generator.js · lines 292–303**

```js
    // ── Metric tokenization + fidelity verification ────────────
    // Substitute {{METRIC_key}} with exact verified values, then
    // verify. Token integrity always blocks (an unknown token would
    // otherwise print literally / a fabricated metric reference).
    // Strict number-policing (every number must be a verified metric
    // or appear in the research) is OPT-IN via METRIC_FIDELITY_STRICT,
    // because on-by-default it would block research-driven posts whose
    // legitimate numbers (years, counts, cited stats) are not metrics.
    const strictFidelity = (process.env.METRIC_FIDELITY_STRICT || "").trim() === "1";   // ◄
    const sub = substituteMetricTokens(parsed.body, metricsByKey);
    const allowedNumbers = strictFidelity ? extractNumericTokens(researchBlock) : [];
    const fidelity = verifyMetricFidelity(sub.text, metricsByKey, { strict: strictFidelity, allowedNumbers });
```

**If unset / missing:** `("").trim() === "1"` is false, so strict number-policing is **off** — the deliberate default, since on-by-default would block legitimate research-driven numbers (years, counts, cited stats). Token-integrity checks still run regardless. Benign.

---

## MIN_HOURS_BETWEEN_POSTS

Minimum spacing (hours) between published posts, enforced by the scheduler's cadence decision. Default `72`.

**`MIN_HOURS_BETWEEN_POSTS` · src/services/scheduler.js · line 43**

```js
const MIN_HOURS = () => parseInt(process.env.MIN_HOURS_BETWEEN_POSTS || "72", 10);   // ◄
```

**If unset / missing:** Defaults to `72` hours of minimum spacing between published posts in the cadence decision. Benign.

---

## MIN_INDEPENDENT_SOURCES

Distinct independent source names required before there is "enough material" to generate — the corroboration gate. Read **once at module load** (change requires restart). Integer ≥ 1, capped at 10; unset/non-numeric/out-of-range ⇒ `2`, so a bad value can never disable the gate or starve generation.

**`MIN_INDEPENDENT_SOURCES` · src/config/feeds.js · lines 130–142**

```js
function readMinIndependentSources() {
  const raw = process.env.MIN_INDEPENDENT_SOURCES;   // ◄
  if (raw === undefined || raw === null || String(raw).trim() === "") return 2;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n < 1) return 2;
  return Math.min(n, 10);
}

// Minimum source requirements — posts are blocked if not met
export const SOURCE_RULES = {
  // Distinct independent source names required (env: MIN_INDEPENDENT_SOURCES,
  // default 2). Read once at module load; change requires a restart.
  minIndependentSources: readMinIndependentSources(),
```

**If unset / missing:** The reader returns `2` for `undefined`/blank, so the corroboration gate requires 2 distinct independent sources. Fail-safe by construction — a missing or bad value can never disable the gate or push it absurdly high (floored at 1, capped at 10). Read once at module load, so a change requires a restart.

---

## MIN_MINUTES_BETWEEN_SCHEDULED_POSTS

Minimum spacing (minutes) between user-*scheduled* posts (distinct from the automated cadence rule). Default `0` (no extra spacing).

**`MIN_MINUTES_BETWEEN_SCHEDULED_POSTS` · src/services/scheduler.js · line 277**

```js
const SCHEDULE_SPACING_MIN = () => parseInt(process.env.MIN_MINUTES_BETWEEN_SCHEDULED_POSTS || "0", 10);   // ◄
```

**If unset / missing:** Defaults to `0`, which disables the extra spacing check between user-*scheduled* posts (distinct from the automated cadence rule). Benign — scheduling simply has no minimum gap.

---

## MOCK_AUTH_ENABLED

Enables the mock auth provider for dev/test. Gated behind a hard production block: `isConfigured()` returns `false` whenever `NODE_ENV === "production"`, regardless of this flag.

**`MOCK_AUTH_ENABLED` · src/auth/providers/mock.js · lines 34–37**

```js
  isConfigured() {
    if (process.env.NODE_ENV === "production") return false;   // ◄ production block wins
    return process.env.MOCK_AUTH_ENABLED === "true";           // ◄
  },
```

**If unset / missing:** Not equal to `"true"`, so the mock provider is not configured; and in production it is disabled regardless of this flag. Unset is the safe default — no mock auth.

---

## NODE_ENV

The single most security-load-bearing variable in the app. It is the **only** input that flips cookie `Secure`, HSTS, the dev auth bypass, the mock provider, the "auth required" default, and test-only guards. The posture is fail-closed: only the literal `"dev"` enables bypass, and only `"production"` enables the hardening — any other value (including unset) enforces auth but also won't set `Secure`/HSTS. (Per your hardening backlog: `dotenv` `override:false` so a runtime `NODE_ENV` wins over `.env`, and the `syntheticDevUser()` production guard, both reinforce this var.) Distinct-purpose reads below; full site index follows.

**`NODE_ENV` · src/auth/session.js · line 174  (session cookie `Secure` flag)**

```js
  res.cookie(SESSION_COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',   // ◄ also at lines 228 (clearSession) and 289 (refresh)
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });
```

**`NODE_ENV` · src/index.js · lines 89–91  (HSTS header, production only)**

```js
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");   // ◄
    }
```

**`NODE_ENV` · src/auth/index.js · lines 166–167  ("auth required" default)**

```js
  const isProduction = process.env.NODE_ENV === "production";
  authRequired = isProduction;   // ◄ production ⇒ auth mandatory
```

**`NODE_ENV` · src/auth/index.js · lines 412–415  (test-only API hard-blocked in prod)**

```js
export function _patchSnapshotForTesting(providerName, overrides) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("_patchSnapshotForTesting cannot be used in production");   // ◄
  }
```

**`NODE_ENV` · src/auth/providers/auth0.js · line 120  (drives the production-origin requirement)**

```js
  const isProd = process.env.NODE_ENV === "production";   // ◄ forces empty localhost-less origin in prod
```

**Full site index (13 live reads):** `auth/middleware.js:50` (dev-bypass gate, condition 1 — shown under `DEV_BYPASS_ORIGINS`); `auth/providers/auth0.js:120`; `auth/providers/mock.js:35` (shown under `MOCK_AUTH_ENABLED`); `auth/index.js:166`, `:176` (log field), `:413`; `auth/session.js:174`, `:228`, `:289`; `index.js:89`, `:304`, `:420` (dev-bypass mode — shown under `DEV_BYPASS_ORIGINS`), `:661` (banner).

**If unset / missing:** This is the highest-impact absence in the inventory. Because every gate compares against the *literal* `"production"` or `"dev"`, an unset (or misspelled) value is treated as neither and lands in the most permissive non-bypass posture: session cookies are issued **without** the `Secure` flag, the **HSTS** header is not sent, the `authRequired` default flips to **false**, the test-only `_patchSnapshotForTesting` API is **not** blocked, the Auth0 production-origin requirement is not enforced, and the mock provider may be enabled. The one thing that stays safe is the dev bypass itself (it requires the exact string `"dev"`). The practical danger: shipping to production with `NODE_ENV` unset or mistyped silently disables `Secure`, HSTS, the auth-required default, and the test-API block at once. Your backlog items — `dotenv` `override:false` so a real runtime value wins over `.env`, plus production fail-loud guards — are precisely the mitigations; until they land, the integrity of this one string is the integrity of the whole hardening posture.

---

## PGDATABASE

Postgres database name. **Plaintext by design** (the DB name is not a secret) — read as-is, required (missing ⇒ throw), and intentionally *not* scrubbed from the environment so the startup banner can display it.

**`PGDATABASE` · src/db/pool.js · lines 49–52**

```js
const database = (process.env.PGDATABASE || "").trim();   // ◄ plaintext, required
if (!database) {
  throw new Error("Missing required environment variable: PGDATABASE");
}
```

**`PGDATABASE` · scripts/dbshell.mjs · lines 80–81  (the `dbshell`/`verify` CLI)**

```js
const PGDATABASE = (process.env.PGDATABASE || "").trim();   // plaintext by design   // ◄
if (!PGDATABASE) die(3, "PGDATABASE missing from .env");
```

**If unset / missing:** `("").trim()` is empty → the pool throws `"Missing required environment variable: PGDATABASE"` at load and the app **cannot start** (the `dbshell`/`verify` CLI dies the same way). Fail-closed. Plaintext by design, and intentionally not scrubbed so the banner can display it.

---

## PGHOST

**Encrypted at rest.** Member of the `ENCRYPTED_VARS` set decrypted at pool load via `decryptRequired()` (bracket access `process.env[name]`), then the **ciphertext is scrubbed** from the environment so neither ciphertext nor plaintext lingers in `/proc/<pid>/environ`. Plaintext lives only in the in-memory pool config. Missing/undecryptable ⇒ throw (fail-closed). The same four vars are decrypted identically by the `dbshell` CLI.

**`PGHOST` · src/db/pool.js · lines 23, 25–43, 46–47, 64  (declare set, decrypt, scrub)**

```js
const ENCRYPTED_VARS = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"];   // ◄ line 23

function decryptRequired(name) {
  const cipher = (process.env[name] || "").trim();   // ◄ dynamic per-name lookup
  if (!cipher) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  let plain;
  try {
    plain = decryptPlatformSecret(cipher);
  } catch (e) {
    throw new Error(
      `${name} could not be decrypted — is it encrypted with the current ` +
      `ENCRYPTION_SECRET? (${e.message})`
    );
  }
  if (!plain) {
    throw new Error(`${name} decrypted to an empty value`);
  }
  return plain;
}

// Decrypt the four secret connection vars. PGDATABASE stays plaintext.
const conn = {};
for (const v of ENCRYPTED_VARS) conn[v] = decryptRequired(v);   // ◄ line 47
// ...
for (const v of ENCRYPTED_VARS) delete process.env[v];   // ◄ line 64 — scrub ciphertext after use
```

**If unset / missing:** `decryptRequired("PGHOST")` throws `"Missing required environment variable: PGHOST"` and the pool fails to initialize, so **the application cannot start** — no database. The same failure occurs if the value is present but cannot be decrypted (wrong/absent `ENCRYPTION_SECRET`) or decrypts to empty. Fail-closed. (The same applies identically to `PGPORT`, `PGUSER`, and `PGPASSWORD`; the ciphertext is scrubbed from the environment immediately after decryption.)

---

## PGPASSWORD

**Encrypted at rest.** Member of `ENCRYPTED_VARS` — decrypted and scrubbed identically to `PGHOST` (see that section). Consumed only as the in-memory pool password; never logged (the `connectionInfo` summary deliberately omits it).

**`PGPASSWORD` · src/db/pool.js · line 79  (in-memory pool config — value via `conn.PGPASSWORD`)**

```js
export const pool = new pg.Pool({
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,
  password: conn.PGPASSWORD,   // ◄ never echoed to logs/banner
  database,
```

**If unset / missing:** Same fail-closed boot failure as `PGHOST` — `decryptRequired` throws and the pool will not initialize. The decrypted value is used **only** as the in-memory pool password and is deliberately omitted from the `connectionInfo` summary and banner, so it is never logged.

---

## PGPORT

**Encrypted at rest.** Member of `ENCRYPTED_VARS` (decrypt + scrub as `PGHOST`). After decryption the plaintext is parsed and validated as a positive integer before use.

**`PGPORT` · src/db/pool.js · lines 54–57  (post-decrypt validation)**

```js
const port = parseInt(conn.PGPORT, 10);   // ◄ decrypted value, then validated
if (!Number.isInteger(port) || port < 1) {
  throw new Error("PGPORT did not decrypt to a valid port number");
}
```

**If unset / missing:** Same fail-closed boot failure as `PGHOST`. Additionally, even when present it must **decrypt to a valid positive integer** — otherwise `parseInt(conn.PGPORT,10)` fails the `Number.isInteger / >= 1` check and throws `"PGPORT did not decrypt to a valid port number"`. Either way the pool does not start.

---

## PGUSER

**Encrypted at rest.** Member of `ENCRYPTED_VARS` (decrypt + scrub as `PGHOST`). Used as the pool user and surfaced in the non-secret `connectionInfo` summary / startup banner.

**`PGUSER` · src/db/pool.js · lines 68–72  (non-secret connection summary)**

```js
export const connectionInfo = {
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,   // ◄ safe to display; password intentionally excluded
  database
};
```

**If unset / missing:** Same fail-closed boot failure as `PGHOST`. When present, the decrypted user is also surfaced in the non-secret `connectionInfo` summary / startup banner (safe to display; the password is excluded).

---

## PLATFORM_ADMIN_DB_ROLE

**Encrypted at rest.** The Postgres role applied via `SET LOCAL ROLE` for the Platform Admin Console's registry queries. No default — unset ⇒ admin queries disabled (fail-closed). Decrypted, then **regex-validated as a safe SQL identifier *after* decrypt** because it is interpolated into `SET LOCAL ROLE` (defends against a tampered ciphertext injecting SQL).

**`PLATFORM_ADMIN_DB_ROLE` · src/routes/platform-admin-api.js · lines 55–70**

```js
function resolveAdminRole() {
  if (ADMIN_DB_ROLE) return ADMIN_DB_ROLE;
  const cipher = process.env.PLATFORM_ADMIN_DB_ROLE;   // ◄
  if (!cipher || typeof cipher !== "string" || cipher.trim().length === 0) {
    throw new Error("PLATFORM_ADMIN_DB_ROLE is not set — platform admin queries are disabled");
  }
  let role;
  try {
    role = decryptPlatformSecret(cipher.trim());
  } catch {
    throw new Error("PLATFORM_ADMIN_DB_ROLE could not be decrypted — platform admin queries are disabled");
  }
  const trimmed = role.trim();
  // Validate AFTER decrypt — the role is interpolated into SET LOCAL ROLE,
  // so it must be a safe PostgreSQL identifier regardless of source.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {   // ◄ identifier allowlist
```

**If unset / missing:** `resolveAdminRole()` throws `"…platform admin queries are disabled"`, so the Platform Admin Console's registry queries are **off** (every admin query is refused); the rest of the app is unaffected. Fail-closed. Note the defense-in-depth: because the role is interpolated into `SET LOCAL ROLE`, the decrypted value is validated against an identifier allowlist *after* decryption, so even a tampered ciphertext cannot inject SQL.

---

## PLATFORM_ADMIN_SUBS

**Encrypted at rest.** Comma-separated list of platform-admin `sub`s gating `isPlatformAdmin()`. Decrypted once and cached on ciphertext; missing or undecryptable ⇒ no admins (**fail-closed** — an attacker cannot become admin by corrupting the value).

**`PLATFORM_ADMIN_SUBS` · src/tenant/platform-db.js · lines 167–181**

```js
function getAdminSubs() {
  const cipher = process.env.PLATFORM_ADMIN_SUBS;   // ◄
  if (!cipher || cipher.trim().length === 0) return null;
  if (cipher === cachedAdminSubsCipher) return cachedAdminSubs;
  let plaintext;
  try {
    plaintext = decryptPlatformSecret(cipher.trim());
  } catch {
    return null; // fail closed on undecryptable value
  }
  const list = plaintext.split(",").map((s) => s.trim()).filter(Boolean);
  cachedAdminSubsCipher = cipher;
  cachedAdminSubs = list;
  return list;
}
```

**If unset / missing:** `getAdminSubs()` returns `null`, so **no platform admins exist** — every `isPlatformAdmin()` check fails and all platform-admin-gated routes (admin console, `/models`, genre administration, etc.) are denied to everyone. Fail-closed: you cannot accidentally grant admin by leaving it unset, and a corrupted value cannot mint an admin — the cost is locking yourself out of admin features until it is set correctly.

---

## PLATFORM_ANTHROPIC_API_KEY

**Encrypted at rest.** Platform-level Anthropic key used solely by the admin `/models` endpoint to list available model IDs. Unset/undecryptable ⇒ `503` (fail-closed); only model IDs are returned (no pricing/keys/capabilities), and the route sits behind the `isPlatformAdmin` gate.

**`PLATFORM_ANTHROPIC_API_KEY` · src/routes/platform-admin-api.js · lines 662–674**

```js
  router.get("/models", async (req, res) => {
    const encKey = process.env.PLATFORM_ANTHROPIC_API_KEY;   // ◄
    if (!encKey || encKey.trim().length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    let apiKey;
    try {
      apiKey = decryptPlatformSecret(encKey.trim());
    } catch (err) {
      platformLog("error", "platform_key_decrypt_failed", { admin: req.user.sub });
      return res.status(503).json({ error: "Model listing is not configured" });
    }
```

**If unset / missing:** The admin `/models` endpoint returns `503` ("Model listing is not configured"); an undecryptable value does the same. Only that one feature degrades — nothing else uses this key — and the route already sits behind `isPlatformAdmin`. Fail-closed.

---

## PREFERRED_POST_HOUR

Primary daily hour the scheduler runs (a second pass is auto-added 12h later). Default `"9"` ⇒ checks at 09:00 and 21:00.

**`PREFERRED_POST_HOUR` · src/services/scheduler.js · lines 347–351**

```js
export function startScheduler() {
  const hour = process.env.PREFERRED_POST_HOUR || "9";   // ◄
  const secondHour = (parseInt(hour) + 12) % 24;

  schedulerJob = cron.schedule(`0 ${hour},${secondHour} * * *`, () => {
```

**If unset / missing:** Defaults to `"9"`, so the scheduler ticks at 09:00 and (auto-added 12 h later) 21:00. Benign. Note the value is interpolated **un-validated** into the cron string — a non-numeric *explicit* value would corrupt the expression, but unset safely yields `"9"`, so the risk is a malformed explicit value, not absence.

---

## PUBLIC_ORIGIN

Public origin used to build the registration link in the invite email. Falls back to the request's own `protocol://host` when unset.

**`PUBLIC_ORIGIN` · src/routes/registration-api.js · lines 110–113**

```js
    const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;   // ◄
    const brandName = process.env.BRAND_NAME || "Content Agent";
    const appName = process.env.APP_NAME || "Content Agent";
    const registerUrl = `${origin}/app/register#token=${invite.token}`;
```

**If unset / missing:** The registration link is built from the incoming request's own `protocol://host`. Usually fine, but it inherits whatever Express sees: behind a proxy that doesn't set `X-Forwarded-*` (or without `trust proxy` configured), `req.protocol`/`req.get("host")` can be the internal values, producing an invite URL that points at an internal host. Setting it explicitly removes that proxy dependency.

---

## REGISTRATION_INVITE_TTL_MINUTES

Lifetime (minutes) of a self-service registration invite token. Positive-int validated; default `15`.

**`REGISTRATION_INVITE_TTL_MINUTES` · src/tenant/platform-db.js · lines 200–203**

```js
function getRegistrationTTL() {
  const envVal = parseInt(process.env.REGISTRATION_INVITE_TTL_MINUTES, 10);   // ◄
  return envVal > 0 ? envVal : DEFAULT_TTL_MINUTES;
}
```

**If unset / missing:** `NaN` fails `>0` → default `15` minutes for the invite-token lifetime. Benign.

---

## SESSION_MAX_AGE_MS

Session lifetime (ms) and the cookie `maxAge`. **This is your "commented-sections" exemplar:** two prior values (24h, 1h) are commented out directly above the active line, which is the kind of thing that throws off line-number estimates — the active value is the **third** line, `300000` (5 minutes). Invalid/unset ⇒ `300000`. The short TTL is mitigated by the sliding-window refresh (`SESSION_MAX_AGE_REFRESH_RATIO`). Also consumed as `maxAge` at `session.js:177` and `:292`.

**`SESSION_MAX_AGE_MS` · src/auth/session.js · lines 32–34  (two commented alternates + the live value)**

```js
// export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 86400000; // 24h   ◄ commented
// export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 3600000; // 1h     ◄ commented
export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 300000; // 5m         ◄ ACTIVE
```

**If unset / missing:** `parseInt(undefined,10) || 300000` → `300000` (5 minutes), the active value. Benign for security (short base lifetime), and mitigated by the sliding-window refresh. The `|| 300000` shape means an explicit `0` also becomes 5 minutes — you cannot zero it — but unset is handled cleanly.

---

## SESSION_MAX_AGE_REFRESH_RATIO

Sliding-window refresh trigger: the session cookie is re-issued once `elapsed / SESSION_MAX_AGE_MS` exceeds this ratio. Validated to `[0.0, 1.0]`; `NaN`/out-of-range ⇒ `0.75`.

**`SESSION_MAX_AGE_REFRESH_RATIO` · src/auth/session.js · lines 43–47**

```js
const SESSION_MAX_AGE_REFRESH_RATIO = (() => {
  const val = parseFloat(process.env.SESSION_MAX_AGE_REFRESH_RATIO);   // ◄
  if (isNaN(val) || val < 0 || val > 1) return 0.75;
  return val;
})();
```

**If unset / missing:** `parseFloat(undefined)` → `NaN` → default `0.75`, so the session cookie is re-issued after 75% of the base window (~3.75 minutes of activity on the 5-minute default). Benign.

---

## SESSION_SECRET

**Session key material** (plaintext, but validated). HKDF input for the AES-256-GCM session-cookie key. Must be ≥ 32 chars and valid hex, else a hard throw (fail-closed) — and the error message is deliberately generic so it leaks nothing. Distinct from `ENCRYPTION_SECRET` (different domain, different HKDF info string).

**`SESSION_SECRET` · src/auth/session.js · lines 75–84**

```js
function getSecret() {
  const secret = process.env.SESSION_SECRET;   // ◄
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('Session configuration invalid.');   // ◄ generic — no detail leak
  }
  if (!/^[0-9a-f]+$/i.test(secret)) {
    throw new Error('Session configuration invalid.');
  }
  return secret;
}
```

**If unset / missing:** `getSecret()` throws `"Session configuration invalid."` (the message is deliberately generic and leaks nothing) the first time a session is created or read. The app may boot, but **no one can log in or hold a session** — authentication is effectively dead. Fail-closed; distinct key material from `ENCRYPTION_SECRET`.

---

# Audit findings summary

The configuration layer is, overall, in good shape: nearly every numeric/threshold var is range-validated with a safe fallback, every at-rest secret fails **closed** on a missing or undecryptable value, and DB-connection ciphertexts are scrubbed from the process environment after decryption. The items below are the deltas worth tracking — none is an emergency.

**Vestigial / dead reads (cleanup, low risk)**
- `ENCRYPTION_SALT` and `ANTHROPIC_API_KEY_ENCRYPTED` — **no live read**; only `delete`d at boot. The code comment already says they're removable. Drop from `.env`.
- `AGENT_MODE` — its only data read (`database.js:136`) is in code the file labels `// UNREACHABLE CODE` after an unconditional `throw`. Only live effect is the cosmetic startup banner.
- `getDashboardFeedLimit()` (`config/research.js`) — the validating getter is **defined but never called**; the live read bypasses it.

**Dual-read / DRY (consistency, low risk)**
- `DASHBOARD_FEED_LIMIT` and `MAX_POSTS_PER_10_DAYS` each have a validating getter *and* an inline `parseInt(...)` re-read in `routes/api.js`. For `DASHBOARD_FEED_LIMIT` the two even differ in rigor (inline read has no radix and treats `0` as falsy). Route them through the single getter.

**Minor robustness**
- `LINKEDIN_REDIRECT_URI` — no presence guard; if unset, `redirect_uri: undefined` is sent to LinkedIn. It's public config (not a secret), so a loud startup check is cheap.
- Startup banner (`index.js:662`) prints `${process.env.DEV_BYPASS_ORIGINS}` unlabelled; when unset it renders the literal `"undefined"` in production logs. Cosmetic.

**Security-critical concentration**
- `NODE_ENV` alone gates cookie `Secure`, HSTS, dev bypass, the mock provider, the auth-required default, and test-only guards. The posture is correctly fail-closed (only `"dev"` enables bypass; only `"production"` enables hardening; anything else enforces auth). Your backlog items — `dotenv` `override:false` so runtime `NODE_ENV` wins, and the `syntheticDevUser()` production guard — are the right reinforcements; until they land, the integrity of this one string is the integrity of the whole auth posture.