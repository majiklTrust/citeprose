// ═══════════════════════════════════════════════════════════════
// Platform Logger — console-only logging for tenant-less contexts
// ═══════════════════════════════════════════════════════════════
//
// Used by code paths that run BEFORE or WITHOUT any tenant
// context — auth registry initialization, OAuth callback
// handlers, auth middleware token-rejection events, etc.
//
// The tenant-scoped logActivity (in database.js) writes to the
// activity_log table via RLS and requires a withTenant block.
// Calling it outside that block throws. platformLog writes to
// the console instead, preserving the diagnostic trail without
// database involvement.
//
// Shared module so both index.js and api.js (and any future
// consumer) import from one place, avoiding duplication and
// circular dependencies.

export function platformLog(level, action, details) {
  const ts = new Date().toISOString();
  const upper = String(level || "info").toUpperCase();
  const payload = details === null || details === undefined ? "" : (
    typeof details === "string" ? details : JSON.stringify(details)
  );
  console.log(`${ts} [PLATFORM:${upper}] ${action}${payload ? " " + payload : ""}`);
}
