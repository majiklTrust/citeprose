// ═══════════════════════════════════════════════════════════════
// src/db/pool.js — PostgreSQL connection pool singleton
// ═══════════════════════════════════════════════════════════════
// Single shared pool for the application. Every query goes
// through this pool or through a dedicated client checked out
// via withTenant() in with-tenant.js.
//
// Reads connection parameters from process.env:
//   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
//
// The pg driver reads these automatically when no explicit
// config is passed, but we set them explicitly for clarity
// and to fail fast if any are missing.
// ═══════════════════════════════════════════════════════════════

import pg from "pg";

const requiredVars = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];
for (const v of requiredVars) {
  if (!process.env[v]) {
    throw new Error(`Missing required environment variable: ${v}`);
  }
}

export const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT, 10),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  // Conservative defaults — tune when concurrency grows.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Convenience wrapper — fires a query against the shared pool
// without checking out a dedicated client. Use this for simple
// one-shot reads that don't need tenant context. For tenant-
// scoped work, use withTenant() from with-tenant.js instead.
export async function query(text, params) {
  return pool.query(text, params);
}

// Graceful shutdown helper — call from the application's
// SIGTERM/SIGINT handler to drain the pool before exit.
export async function closePool() {
  await pool.end();
}
