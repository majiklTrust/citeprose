# Migration: single-DB → multi-tenant silo

This directory holds the one-shot migration that converts the
pre-multitenant `linkedin-agent.sqlite` (one global database) into
the multi-tenant silo layout (`platform.sqlite` + one
`tenants/<tenant_id>.sqlite` per tenant).

## Files

- `sql/platform-schema.sql` — schema for the global platform DB
  (`tenants`, `memberships`, `schema_version`). Idempotent.
- `sql/tenant-schema-additions.sql` — schema additions applied to
  each tenant's own DB after the legacy tables are copied in
  (`topics`, `feeds`, `credentials`, `tenant_schema_version`).
  Idempotent.
- `migrate-to-multitenant.mjs` — orchestrator. Performs all 11
  steps end-to-end. Supports `--dry-run` for inspection. Each
  step is independently idempotent so the script is safe to
  re-run if it crashes partway through.

## Prerequisites

The script must be run from the **linkedin-agent project root**
(where `package.json` lives). It needs:

- `node_modules/better-sqlite3` installed (run `npm ci` first if
  you're working from a fresh checkout)
- A valid `.env` containing `ENCRYPTION_SECRET` and
  `ENCRYPTION_SALT` (used to decrypt the existing platform-encrypted
  Anthropic API key, which is then re-encrypted under a per-tenant
  derived key)
- The existing `linkedin-agent.sqlite` to migrate from
- `src/config/topics.js` and `src/config/feeds.js` (they get
  imported and seeded into the tenant's DB)

## What gets migrated

| Source                                  | Destination                                       |
|-----------------------------------------|---------------------------------------------------|
| `linkedin-agent.sqlite` :: posts        | `tenants/tenant_001.sqlite` :: posts              |
| `linkedin-agent.sqlite` :: agent_state  | `tenants/tenant_001.sqlite` :: agent_state        |
| `linkedin-agent.sqlite` :: activity_log | `tenants/tenant_001.sqlite` :: activity_log       |
| `linkedin-agent.sqlite` :: articles     | `tenants/tenant_001.sqlite` :: articles           |
| `src/config/topics.js` :: TOPICS        | `tenants/tenant_001.sqlite` :: topics             |
| `src/config/feeds.js`  :: FEEDS         | `tenants/tenant_001.sqlite` :: feeds              |
| `.env` :: ANTHROPIC_API_KEY_ENCRYPTED   | `tenants/tenant_001.sqlite` :: credentials        |
| `.env` :: LINKEDIN_ACCESS_TOKEN         | `tenants/tenant_001.sqlite` :: credentials        |
| `.env` :: LINKEDIN_PERSON_URN           | `tenants/tenant_001.sqlite` :: credentials        |
| (new)                                   | `platform.sqlite` :: tenants                      |
| (new)                                   | `platform.sqlite` :: memberships                  |

The four legacy tables are **copied verbatim** with their existing
column structure — no schema change. The new tables are added
alongside them.

## Running it

### Step 1 — Always do a dry-run first

```bash
cd /path/to/linkedin-agent
node scripts/migration/migrate-to-multitenant.mjs \
  --auth-sub "auth0|YOUR_AUTH0_USER_ID" \
  --dry-run
```

The dry-run reads from `.env` and `linkedin-agent.sqlite`, attempts
to decrypt the platform-encrypted Anthropic key (so you find out
*now* if the secret/salt is wrong), and prints what every step
would do. **No files are written and no databases are opened for
write.**

If anything in the dry-run output looks wrong — wrong tenant ID,
wrong number of topics or feeds, decrypt failures — fix it before
the real run.

### Step 2 — Real run

```bash
cd /path/to/linkedin-agent
node scripts/migration/migrate-to-multitenant.mjs \
  --auth-sub "auth0|YOUR_AUTH0_USER_ID" \
  --tenant-name "Brandon's Tenant"
```

After it completes you should see:

```
linkedin-agent.sqlite                       (unchanged)
linkedin-agent.sqlite.pre-multitenant.bak   (backup of the above)
platform.sqlite                             (NEW)
tenants/
  tenant_001.sqlite                         (NEW — Brandon's data)
```

### Required flags

| Flag | Purpose |
|---|---|
| `--auth-sub SUB` | Owner's auth identity. For Auth0 this is the full sub like `auth0|abc123` or `google-oauth2|xyz789`. For WorkOS it's the user_id like `user_01H...`. |

### Optional flags (defaults shown)

| Flag | Default | Purpose |
|---|---|---|
| `--auth-provider auth0` | `auth0` | Auth provider for the owner. Use `workos` for WorkOS-backed tenants. |
| `--tenant-id tenant_001` | `tenant_001` | Tenant identifier. |
| `--tenant-name NAME` | derived | Display name shown in dashboard. |
| `--source-db PATH` | `./linkedin-agent.sqlite` | Source SQLite to migrate from. |
| `--platform-db PATH` | `./platform.sqlite` | Output platform DB. |
| `--tenants-dir PATH` | `./tenants` | Output directory for tenant DBs. |
| `--env-file PATH` | `./.env` | Where to read credentials from. |
| `--backup-suffix SUFFIX` | `pre-multitenant.bak` | Backup file suffix. |
| `--dry-run` | (off) | Inspect what would happen, write nothing. |
| `--verbose` | (off) | Verbose step logging. |

## Idempotency

Every step checks "has this already been done?" before doing it.
Re-running the script is safe:

- Backup file already exists → skip backup
- Platform DB already exists → open and re-apply schema (no-op
  thanks to `CREATE TABLE IF NOT EXISTS`)
- Tenant row already exists → skip insert
- Membership already exists → skip insert
- Tenant DB has rows in posts/agent_state/etc. → skip table copy
- Topics already seeded → skip
- Feeds already seeded → skip
- Credentials already present → skip

This means if the script crashes in step 9 (topic seeding), you
can fix the underlying issue and re-run. Steps 1-8 will all log
"skip" and step 9 will pick up where it left off.

## Rollback

If something goes wrong AFTER the migration runs and you need to
roll back to the pre-multitenant state:

1. Stop the application (`pm2 stop linkedin-agent`)
2. Replace the source DB from the backup:
   ```bash
   rm linkedin-agent.sqlite
   cp linkedin-agent.sqlite.pre-multitenant.bak linkedin-agent.sqlite
   ```
3. Remove the new artifacts:
   ```bash
   rm -f platform.sqlite
   rm -rf tenants/
   ```
4. Revert the application code to pre-multitenant
5. Restart

The backup file is created before any destructive operation, so
the original data is always recoverable as long as the backup file
exists. **Do not delete the backup until you have verified the
multi-tenant deployment is working.**

## Limitations / known gaps

- `ROTATION_CONFIG`, `TRUST_TIERS`, and `SOURCE_RULES` from
  `topics.js` and `feeds.js` are NOT migrated — they remain as
  platform-level code constants because they govern how the
  research engine works, not what content the tenant generates.
  This is documented in `docs/architecture-multitenant.md`.
- The script seeds topics and feeds from the **current contents**
  of `src/config/topics.js` and `src/config/feeds.js`. If those
  files have been edited since pre-migration, the migrated tenant
  will get the current versions, not historical ones. This is
  almost certainly what you want.
- Multi-user-per-tenant is not supported in v1. The schema
  includes a `memberships` table with `UNIQUE(auth_provider,
  auth_sub)` enforcing one user = one tenant. Lifting this is a
  schema migration in v2.
