# LinkedIn Agent — PostgreSQL Schema (Parallel Workspace)

This directory contains the PostgreSQL DDL for a **separate**
multi-tenant workspace. The application's primary database is
SQLite (silo isolation, one file per tenant) — these files are
NOT a migration target. They build the same logical schema in
PostgreSQL using PostgreSQL idioms and best practices.

## Prerequisites

- PostgreSQL **17** (the DDL uses features available in pg15+
  but is tested against 17 only)
- `psql` client
- An empty PostgreSQL database created and ready, e.g.:
  ```bash
  createdb linkedin_agent
  ```
- A connection that can `CREATE ROLE` (superuser or a role
  with `CREATEROLE`) — the role grants in `04-roles.sql`
  require this.

## File order

Run the four SQL files in numeric order. They are independent
but later files depend on earlier ones.

| File | What it creates |
|---|---|
| `01-platform.sql` | `tenants`, `memberships`, `schema_version`, `set_updated_at()` trigger function |
| `02-tenant-tables.sql` | All 7 tenant-scoped tables (`topics`, `feeds`, `articles`, `posts`, `agent_state`, `activity_log`, `credentials`) plus `post_status`, `feed_tier`, `log_level` enum types |
| `03-rls.sql` | `current_tenant_id()` helper function and Row-Level Security policies on every tenant table |
| `04-roles.sql` | `linkedin_agent_app` and `linkedin_agent_admin` group roles with appropriate grants |

```bash
psql -d linkedin_agent \
  -f 01-platform.sql \
  -f 02-tenant-tables.sql \
  -f 03-rls.sql \
  -f 04-roles.sql
```

Each file is **idempotent** — re-running is safe and skips
already-applied changes via `CREATE ... IF NOT EXISTS`,
`DROP POLICY IF EXISTS / CREATE POLICY`, and `ON CONFLICT DO
NOTHING` patterns.

## After running the DDL — create login roles

The four SQL files create **group roles** (NOLOGIN). You need
to create LOGIN roles and grant them membership before anything
can connect:

```sql
-- Application runtime role (used by the running app)
CREATE ROLE app_runtime LOGIN PASSWORD 'choose-strong-password';
GRANT linkedin_agent_app TO app_runtime;

-- Admin role (used by migrations and ops scripts)
CREATE ROLE migrator LOGIN PASSWORD 'choose-different-strong-password';
GRANT linkedin_agent_admin TO migrator;
```

The application must connect as `app_runtime`. Migrations and
ops scripts that need cross-tenant visibility connect as
`migrator`. **Never** connect the running application as
`migrator` — that bypasses Row-Level Security.

## How tenant isolation actually works

This schema uses the **pool isolation** model (single database,
shared tables, `tenant_id` column on every tenant-scoped row).
Three independent layers enforce isolation:

### Layer 1 — Schema (composite foreign keys)

Every cross-table reference within a tenant uses a composite
FK that includes `tenant_id`. Example: `posts.topic_id`
references `topics(tenant_id, id)`, not just `topics(id)`. This
makes it **physically impossible** at the schema level for a
post in tenant A to reference a topic in tenant B — the
constraint check fails before any RLS or application logic
runs.

### Layer 2 — Database (Row-Level Security)

Every tenant table has RLS enabled with a single policy
`tenant_isolation`:

```sql
USING (tenant_id = current_tenant_id())
WITH CHECK (tenant_id = current_tenant_id())
```

The application sets the current tenant at the start of each
request, inside a transaction:

```sql
BEGIN;
SET LOCAL app.current_tenant_id = '<tenant-uuid>';

-- Every query in this transaction is automatically filtered
-- to that tenant's rows. INSERTs and UPDATEs are checked the
-- same way.
SELECT * FROM posts;       -- only this tenant's posts
INSERT INTO posts (...);   -- tenant_id must match or fails

COMMIT;
-- Setting is cleared at COMMIT/ROLLBACK. Connection can be
-- safely returned to a pool and reused for another tenant.
```

`SET LOCAL` is critical — it scopes the setting to the
transaction. Without `LOCAL`, the setting would persist across
transactions and pooled connections would leak tenant context
between requests.

### Layer 3 — Application

Application code should still pass tenant context explicitly
and use parameterized queries. RLS is the safety net, not the
primary control. All three layers have to fail simultaneously
for a cross-tenant data leak to occur.

## Adding a new tenant

Tenant creation is an admin operation, performed as
`linkedin_agent_admin` (or any role with BYPASSRLS):

```sql
-- 1. Create the tenant row
INSERT INTO tenants (slug, name, created_by)
VALUES ('tenant_002', 'Acme Corporation', 'admin@example.com')
RETURNING id;
-- (note the returned UUID for the next step)

-- 2. Map the auth identity to the tenant
INSERT INTO memberships (tenant_id, auth_provider, auth_sub)
VALUES (
  '<uuid-from-step-1>',
  'auth0',
  'auth0|abc123xyz'
);

-- 3. Optionally seed initial topics, feeds, agent_state, etc.
--    These INSERTs need to bypass RLS (because no current
--    tenant is set yet) — that's why this whole sequence runs
--    as linkedin_agent_admin.
INSERT INTO agent_state (tenant_id, key, value) VALUES
  ('<tenant-uuid>', 'mode', 'manual'),
  ('<tenant-uuid>', 'paused', 'false');
```

The admin role bypasses RLS because of the `BYPASSRLS` role
attribute set in `04-roles.sql`. From the application runtime
role, these INSERTs would fail because `current_tenant_id()`
is NULL.

## Verifying isolation

Quick smoke test after running all four files. From
`linkedin_agent_admin`:

```sql
-- Create two test tenants
INSERT INTO tenants (slug, name) VALUES ('test_a', 'Test A');
INSERT INTO tenants (slug, name) VALUES ('test_b', 'Test B');

-- Save the UUIDs for the next steps
\gset
SELECT id FROM tenants WHERE slug = 'test_a' \gset a_
SELECT id FROM tenants WHERE slug = 'test_b' \gset b_

-- Insert one row into each tenant
INSERT INTO agent_state (tenant_id, key, value)
VALUES (:'a_id', 'test', 'tenant-a-data');

INSERT INTO agent_state (tenant_id, key, value)
VALUES (:'b_id', 'test', 'tenant-b-data');
```

Now connect as `app_runtime` (the RLS-bound role) and verify
the isolation:

```sql
-- Without setting tenant context, queries return zero rows
SELECT * FROM agent_state;
-- (0 rows — current_tenant_id() is NULL)

-- Set tenant A context — only A's row is visible
BEGIN;
SET LOCAL app.current_tenant_id = '<test_a uuid>';
SELECT key, value FROM agent_state;
--  key  |     value
-- ------+----------------
--  test | tenant-a-data
COMMIT;

-- Set tenant B context — only B's row is visible
BEGIN;
SET LOCAL app.current_tenant_id = '<test_b uuid>';
SELECT key, value FROM agent_state;
--  key  |     value
-- ------+----------------
--  test | tenant-b-data
COMMIT;

-- Try to insert into the wrong tenant — fails
BEGIN;
SET LOCAL app.current_tenant_id = '<test_a uuid>';
INSERT INTO agent_state (tenant_id, key, value)
VALUES ('<test_b uuid>', 'evil', 'cross-tenant-write');
-- ERROR: new row violates row-level security policy for table "agent_state"
ROLLBACK;
```

If all four checks behave as shown, isolation is working.
Clean up the test tenants when done:

```sql
-- As linkedin_agent_admin
DELETE FROM tenants WHERE slug IN ('test_a', 'test_b');
-- ON DELETE CASCADE removes all child rows automatically.
```

## Notable differences from the SQLite schema

The PostgreSQL schema is not a literal port of the SQLite
schema — it uses PostgreSQL types and idioms throughout.

| SQLite | PostgreSQL | Why |
|---|---|---|
| `TEXT` for ISO 8601 timestamps | `TIMESTAMPTZ DEFAULT now()` | Native datetime type, timezone-aware, comparable with operators, indexable as time. |
| `TEXT` for JSON columns | `JSONB DEFAULT '[]'::jsonb` | Compressed binary storage, GIN-indexable, queryable with `->`/`->>`/`@>`. |
| `INTEGER NOT NULL CHECK (x IN (0,1))` for booleans | `BOOLEAN` | Native type, no awkward integer encoding. |
| `BLOB` for encrypted credentials | `BYTEA` | Direct equivalent. |
| `TEXT` PK like `'tenant_001'` | `UUID DEFAULT gen_random_uuid()` for surrogate keys, `slug VARCHAR(64)` for human-readable handles | UUID is the PostgreSQL idiom for distributed identifiers and avoids collisions across tenants. The slug column preserves the human-readable name. |
| `INTEGER PRIMARY KEY AUTOINCREMENT` for high-row-count tables | `BIGINT GENERATED ALWAYS AS IDENTITY` | More efficient than UUID for large tables. Cleaner than `SERIAL` (the old idiom). |
| Status validation via `CHECK (status IN (...))` | Real `ENUM` types | Single-byte storage, self-documenting, ALTER TYPE for evolution. |
| No foreign keys (silo isolation makes them redundant) | Composite FKs `(tenant_id, target_id)` everywhere | Pool isolation requires schema-level cross-tenant safety. |
| No tenant_id column (one DB per tenant) | `tenant_id UUID NOT NULL` on every tenant table | Pool model's defining feature. |

## Notes on the pool isolation choice

You explicitly chose option (a) — single database, public
schema — over the silo equivalent (per-tenant schemas,
option b). The trade-offs:

**What you gain:**
- Single connection pool — much lower overhead at scale than
  per-tenant connection pools
- Cross-tenant aggregate queries are trivial — `SELECT
  count(*), tenant_id FROM posts GROUP BY tenant_id` just
  works (from the admin role)
- Single backup target (one `pg_dump` covers all tenants)
- No schema-management overhead when adding tenants

**What you lose vs. silo:**
- Strong isolation now depends on RLS being correctly
  enabled and the application correctly setting
  `app.current_tenant_id`. A misconfigured connection or a
  forgotten `SET LOCAL` is a potential leak. The composite
  FKs reduce the blast radius but don't eliminate it.
- Tenant deletion is `DELETE FROM tenants WHERE id = ...`
  with CASCADE, vs. the silo model's `rm tenants/xxx.sqlite`.
  Generally fine, but slow for tenants with very large
  history.
- Per-tenant `pg_dump` is awkward — you have to filter by
  `tenant_id` in every table.

The three defense-in-depth layers (composite FKs + RLS +
application discipline) make this safe in practice. **The
single most important operational rule**: never let the
running application connect as a role with `BYPASSRLS`. The
group roles in `04-roles.sql` enforce this by giving
`linkedin_agent_app` the `NOBYPASSRLS` attribute.

## Hardcoded values worth flagging

Per project convention, hardcoded values that should eventually
be parameterized are flagged. In this DDL:

| Value | Where | Rationale |
|---|---|---|
| Role names `linkedin_agent_app` / `linkedin_agent_admin` | `04-roles.sql` | Convention. If you want different role names (e.g., `appname_app`), search and replace. |
| Schema name `public` | All files | Per option (a). To use a dedicated schema, search-and-replace `public` with your schema name and add `CREATE SCHEMA IF NOT EXISTS <name>;` at the top of `01-platform.sql`. |
| Setting name `app.current_tenant_id` | `03-rls.sql` and the README | The `app.` prefix is convention — PostgreSQL allows any custom setting name with at least one period. |
| Enum values for `post_status`, `feed_tier`, `log_level` | `02-tenant-tables.sql` | Match the application's existing values. Add new ones with `ALTER TYPE ... ADD VALUE`. |

## Limitations / known gaps

- **No materialized views, no partitioning.** At small tenant
  counts (low hundreds) and modest row counts (millions of
  posts/articles), the schema is fast as-is. Add partitioning
  on `activity_log` (by `timestamp`) and `articles` (by
  `tenant_id` or `published_at`) when those tables get large.
- **No full-text search indexes.** If you want to search post
  content or article titles, add `tsvector` columns and GIN
  indexes.
- **No connection pooling configuration.** Use PgBouncer in
  transaction mode for the application connection. Session
  mode would defeat the `SET LOCAL app.current_tenant_id`
  pattern.
- **No backup/restore tooling.** Use `pg_dump` /
  `pg_restore` per usual PostgreSQL practice.
