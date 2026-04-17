# Multi-Tenant Architecture Reference

This is a reference document for the multi-tenant LinkedIn Agent
platform. It exists to be useful at 3am when something is broken
and you need to know where to look.

## What changed and why

The application moved from a single global SQLite database
(`linkedin-agent.sqlite`) to a **silo model**: one global
`platform.sqlite` for tenant metadata + one
`tenants/<tenant_id>.sqlite` per tenant for that tenant's data.
There is no shared content database. Tenants are physically
isolated at the file level — a missing `WHERE tenant_id = ?` is
no longer a security bug, it's a syntax error against the wrong
database connection.

The single biggest architectural rule:

> **No service function reads from a database without first
> resolving a tenant context.** All DB access goes through
> `DbFactory.getDb(tenant)`, which returns a connection bound
> to that tenant's file. There is no global "the database"
> anymore.

## The 8 abstractions

These are the components that decouple tenant identity from
business logic. Each is a small module. Code outside these
modules should never touch global state — it goes through
the abstraction.

### 1. PlatformDb
Singleton wrapper around `platform.sqlite`. The **only** code
that opens platform.sqlite. Exposes:
- `findTenantByAuth(provider, sub)` → tenant row or null
- `listActiveTenants()` → array of tenant rows
- `updateTenantStatus(id, status)`
- `createTenant(...)` / `createMembership(...)` (used by admin scripts)

Routes don't talk to PlatformDb directly. They go through
TenantResolver.

### 2. TenantResolver (middleware)
Express middleware that runs *after* `requireAuth`. Reads
`req.user.sub` and `req.user.provider` from the auth payload,
calls `PlatformDb.findTenantByAuth`, and attaches `req.tenant`
(a TenantContext object). Returns 403 if no tenant exists for
the authenticated identity.

After this middleware, every downstream handler can assume
`req.tenant` is present and the user is allowed to use it.

### 3. TenantContext (plain object)
```
{
  id:           "tenant_001",
  name:         "Brandon's Tenant",
  status:       "active",
  dbPath:       "tenants/tenant_001.sqlite",
  authProvider: "auth0",
  createdAt:    "2026-04-09T..."
}
```
Lightweight, passed everywhere a tenant scope is needed. Created
by TenantResolver from a row in `platform.sqlite :: tenants`.
Also created by the scheduler when iterating over all tenants.

### 4. DbFactory
The chokepoint that makes silo isolation enforceable.
- `getDb(tenant)` returns a `better-sqlite3` connection bound
  to that tenant's file
- Caches connections per tenant (one open connection per tenant)
- `closeAll()` for graceful shutdown
- **There is no `getDb()` without a tenant argument.** Removing
  the parameterless version is what makes cross-tenant leaks
  impossible.

### 5. CredentialStore
Encrypted secrets per tenant. AES-256-GCM with a key derived
from `HKDF(ENCRYPTION_SECRET, salt=tenant.id, info="credential-encryption-v1")`.
- `getLinkedInToken(tenant)` / `setLinkedInToken(tenant, token)`
- `getAnthropicKey(tenant)` / `setAnthropicKey(tenant, key)`
- Cached in memory **per request only** — cache cleared after
  the response is sent. No long-lived plaintext anywhere.
- `encryption_version` column on the credentials table lets us
  rotate the derivation scheme later.

### 6. AnthropicClientFactory
- `getClient(tenant)` returns an Anthropic SDK client configured
  with that tenant's BYOK API key
- Caches clients per tenant (the SDK client object is heavyweight)
- Invalidates the cache when a tenant rotates their key

### 7. TopicRepository / FeedRepository
Replaces the static imports of `src/config/topics.js` and
`src/config/feeds.js`. The application code stops caring whether
topics live in code or in DB rows.
- `topics.list(tenant)` → array of topic objects
- `topics.get(tenant, id)` → single topic
- `topics.upsertAll(tenant, json)` → bulk replace from JSON
- Same shape for feeds

### 8. AuthProvider interface
Already exists at `src/auth/providers/`. Adding WorkOS is just
adding `workos.js` next to `auth0.js` and `mock.js`. Provider
selection is per-tenant (stored in `memberships.auth_provider`).

## File structure

```
linkedin-agent/
├── platform.sqlite                    NEW — global tenant metadata
├── linkedin-agent.sqlite.pre-mt.bak   NEW — pre-migration backup
├── tenants/                            NEW — one file per tenant
│   ├── tenant_001.sqlite
│   ├── tenant_002.sqlite
│   └── ...
├── src/
│   ├── platform/                       NEW — platform.sqlite access
│   │   └── platform-db.js
│   ├── tenant/                         NEW — tenant abstractions
│   │   ├── tenant-resolver.js          (middleware)
│   │   ├── tenant-context.js           (TenantContext shape)
│   │   ├── db-factory.js               (per-tenant DB connections)
│   │   ├── credential-store.js         (HKDF + AES-256-GCM)
│   │   ├── topic-repository.js
│   │   └── feed-repository.js
│   ├── services/
│   │   ├── anthropic-client-factory.js NEW — replaces global client
│   │   ├── content-generator.js        UPDATED — takes tenant arg
│   │   ├── research.js                 UPDATED — takes tenant arg
│   │   ├── scheduler.js                UPDATED — iterates tenants
│   │   ├── linkedin-api.js             UPDATED — token from store
│   │   ├── news-monitor.js             UPDATED — feeds from repo
│   │   └── ...
│   ├── routes/
│   │   ├── api.js                      UPDATED — uses req.tenant
│   │   └── ...
│   ├── auth/
│   │   ├── middleware.js               UPDATED — chains TenantResolver
│   │   └── providers/
│   │       ├── auth0.js
│   │       ├── workos.js               NEW
│   │       └── mock.js
│   └── config/
│       ├── topics.js                   DEPRECATED — kept for migration
│       └── feeds.js                    DEPRECATED — kept for migration
├── scripts/
│   └── migration/                      NEW
│       ├── migrate-to-multitenant.mjs
│       ├── README.md
│       └── sql/
│           ├── platform-schema.sql
│           └── tenant-schema-additions.sql
└── docs/
    └── architecture-multitenant.md     this file
```

## Request lifecycle: authenticated API call

What happens when a logged-in user clicks "Preview New Post":

```
1. Browser POSTs to /api/generate-preview with session cookie
   ↓
2. requireAuth middleware
   - Validates session / JWT
   - Sets req.user = { sub: "auth0|abc123", provider: "auth0", ... }
   ↓
3. TenantResolver middleware  ← NEW
   - PlatformDb.findTenantByAuth("auth0", "auth0|abc123")
   - Sets req.tenant = TenantContext{ id: "tenant_001", ... }
   - Returns 403 if no tenant found
   ↓
4. Route handler (api.js)
   - const db = DbFactory.getDb(req.tenant)
   - const anthropic = AnthropicClientFactory.getClient(req.tenant)
   - generatePost(req.tenant, anthropic, db, ...)  ← signature change
   ↓
5. Service functions
   - All take a tenant argument or accept (db, anthropic) tuple
   - No module-level imports of "the" database or "the" client
   ↓
6. Response back to user
   - CredentialStore in-memory cache cleared on response
```

The key invariants enforced by this chain:
- Step 3 cannot be skipped — if `req.tenant` is missing, every
  downstream call fails.
- Step 4 cannot be replaced with a global `db` — there is no
  global db anymore.
- Step 5 cannot accidentally use another tenant's data — the
  `db` and `anthropic` arguments are bound to one tenant.

## Scheduled agent cycle

The pre-migration scheduler ran one global cycle. The
multi-tenant scheduler runs one cycle **per active tenant**:

```
scheduler.tick()  (every N minutes)
   ↓
const tenants = PlatformDb.listActiveTenants()
   ↓
for (const tenantRow of tenants):
   const tenant = TenantContext.from(tenantRow)
   const db = DbFactory.getDb(tenant)
   const anthropic = AnthropicClientFactory.getClient(tenant)
   try:
     await runCycleForTenant(tenant, db, anthropic)
   catch (err):
     logActivity(db, "warn", "tenant_cycle_failed", err)
     // continue to next tenant — one bad tenant can't kill the loop
```

In v1 this is **sequential** — tenant 2's cycle doesn't start
until tenant 1's finishes. With small numbers of tenants (low
single digits) this is acceptable. At ~20+ tenants the global
loop becomes the gating issue and needs to either parallelize
(with a concurrency limit) or move to per-tenant cron expressions.

## Common debugging entry points

### "User logs in but gets 403"
- Check `platform.sqlite :: memberships` for a row matching
  their `(auth_provider, auth_sub)` pair
- TenantResolver returns 403 when no membership exists
- Fix: run `scripts/admin/create-tenant.sh` for the new user

### "User logs in but sees the wrong data"
- Check `req.tenant.id` in the route handler — log it once
- Check `tenants/<tenant_id>.sqlite` exists and has rows
- The most likely cause is a route handler that bypasses
  DbFactory and uses a stale module-level connection. Grep for
  `new Database(` outside `db-factory.js` — there should be
  none in the application code.

### "Anthropic calls fail with auth error"
- Tenant's API key is wrong, expired, or missing
- Check `tenants/<tenant_id>.sqlite :: credentials` for
  `anthropic_api_key`
- Decrypt manually if needed using the HKDF derivation in
  `credential-store.js`
- AnthropicClientFactory caches clients per tenant — invalidate
  with `factory.invalidate(tenant)` after rotating a key

### "LinkedIn post fails / token expired"
- Token in `tenants/<tenant_id>.sqlite :: credentials` ::
  `linkedin_access_token`
- The OAuth refresh flow is per-tenant — check the activity_log
  for that tenant for `linkedin_token_refresh_failed` entries

### "Scheduler skips a tenant entirely"
- Check `platform.sqlite :: tenants.status` — must be `'active'`
- Check the activity_log of that tenant's DB for
  `tenant_cycle_failed` entries
- Sequential loop means one tenant's cycle hanging blocks all
  later tenants — look for hung HTTP requests in `pm2 logs`

### "Migration script crashed partway through"
- Re-run it. Every step is idempotent.
- The script will skip steps that are already complete and
  pick up where the failure occurred.
- See `scripts/migration/README.md` for the rollback procedure
  if you need to bail out entirely.

## Migration / rollback summary

Migration is **one-shot, idempotent, dry-run-supported**. See
`scripts/migration/README.md` for the procedure. The two
operational commands are:

```bash
# Inspect
node scripts/migration/migrate-to-multitenant.mjs \
  --auth-sub "auth0|YOUR_SUB" --dry-run

# Apply
node scripts/migration/migrate-to-multitenant.mjs \
  --auth-sub "auth0|YOUR_SUB" --tenant-name "Your Name"
```

Rollback is `cp` from the `.pre-multitenant.bak` file plus
removing `platform.sqlite` and `tenants/`.

## What's intentionally deferred to v1.1

These are NOT in the v1 multi-tenant ship and are documented
here so you don't go looking for them at 3am wondering why
they're missing:

- **Async job runner (Option B from the timeout discussion).**
  Preview New Post is still a synchronous HTTP request. The
  CloudFront 120s origin timeout covers it. Resilience to
  browser disconnect during long generation is a v1.1 feature.
- **Multi-user-per-tenant.** Schema supports it, UI doesn't.
  One auth identity = one tenant in v1.
- **Self-serve onboarding wizard.** New tenants are created
  via a CLI admin script (`scripts/admin/create-tenant.sh`).
- **Topic / feed management UI.** Tenants edit via JSON paste
  in v1, not a polished form-based editor.
- **Per-tenant scheduling cadence.** All tenants run on the
  global scheduler tick interval. No per-tenant cron expressions.
- **Parallel scheduler execution.** Sequential tenant iteration
  in the cycle loop. Becomes a bottleneck at ~20+ tenants.
- **Platform admin dashboard.** Tenant management is via SQL
  against `platform.sqlite` and shell scripts on the EC2 box.
- **Per-tenant usage metering.** BYOK Anthropic key means each
  tenant pays Anthropic directly, so platform-side metering is
  not required for billing.
- **Tenant deletion / suspension UI.** Manual via SQL.
- **Cross-tenant article deduplication.** Each tenant's
  `articles` table is independent — duplicate disk usage if
  two tenants subscribe to the same RSS feed. Preserves the
  silo principle; trade-off accepted.

## Hardcoded values to revisit

The following values are intentionally hardcoded in v1 with
rationale comments at the source. Each should be parameterized
in a future cleanup:

| Value | Where | Rationale |
|---|---|---|
| `HKDF_INFO = "credential-encryption-v1"` | `credential-store.js`, `migrate-to-multitenant.mjs` | Version marker — changing it rotates the encryption scheme. Must be deliberate. |
| `PLATFORM_PBKDF2_ITERATIONS = 200000` | `migrate-to-multitenant.mjs` | Must match the legacy `src/services/encryption.js` scheme to decrypt existing credentials. |
| `AES_KEY_LENGTH_BYTES = 32` etc | various | AES-256-GCM protocol constants. Never change. |
| `TABLES_TO_COPY = [...]` | `migrate-to-multitenant.mjs` | Hardcoded list of legacy tables to migrate. Tenant-DB schema is derived from this list. |
| Sequential scheduler loop | `scheduler.js` | Acceptable at small tenant counts. Replace with bounded-concurrency worker pool when needed. |
