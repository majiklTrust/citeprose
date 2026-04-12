# src/db/ — PostgreSQL access layer

## Modules

### pool.js
Shared `pg.Pool` singleton. Reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` from `process.env`. Exports:
- `pool` — the Pool instance (for advanced use)
- `query(text, params)` — convenience wrapper for one-shot queries
- `closePool()` — drain the pool on shutdown

### with-tenant.js
AsyncLocalStorage-based tenant context. Exports:
- `withTenant(tenantId, fn)` — wraps `fn` in BEGIN / SET LOCAL / COMMIT. The callback receives a dedicated `pg.Client` as its first argument. RLS policies enforce tenant isolation automatically.
- `currentTenantId()` — returns the active tenant UUID, or `null` outside a `withTenant` block.
- `currentClient()` — returns the active `pg.Client`, or `null`. Used internally by `credential-store.js`.

## Usage pattern

```js
import { withTenant } from './db/with-tenant.js';

// In a route handler:
app.get('/api/posts', requireAuth, tenantResolver, async (req, res) => {
  const posts = await withTenant(req.tenant.id, async (client) => {
    const r = await client.query('SELECT * FROM posts ORDER BY created_at DESC');
    return r.rows;
  });
  res.json(posts);
});

// In the scheduler:
for (const tenant of await listActiveTenants()) {
  await withTenant(tenant.id, async (client) => {
    await runCycleForTenant(client);
  });
}
```

## Why SET LOCAL instead of WHERE tenant_id = ?

Both work. SET LOCAL + RLS is defense in depth — even if application code forgets a WHERE clause, the database rejects cross-tenant access. The WHERE clause is still recommended for query clarity, but RLS is the safety net that makes a missing WHERE a performance bug, not a security bug.
