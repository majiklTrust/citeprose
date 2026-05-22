#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/diagnose-tenant.mjs — Tenant resolution diagnostic
// ═══════════════════════════════════════════════════════════════
// Runs the exact same code paths the app uses (same pool, same
// role, same grants) and reports what it finds. If the problem
// is a missing membership, offers to create one interactively.
//
// Usage:
//   node scripts/diagnose-tenant.mjs
//   node scripts/diagnose-tenant.mjs --fix
// ═══════════════════════════════════════════════════════════════
import "dotenv/config";
import { query } from "../src/db/pool.js";
import { findTenantByAuthIdentity, findPendingInviteByEmail } from "../src/tenant/platform-db.js";
import { createInterface } from "readline";

const FIX_MODE = process.argv.includes("--fix");
const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";
const INFO = "ℹ️ ";
let exitCode = 0;

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(50 - title.length)}`);
}

// ── 1. Connection test ──────────────────────────────────────
section("Database connection");

let connResult;
try {
  connResult = await query("SELECT current_user, current_database(), version()");
  const row = connResult.rows[0];
  console.log(`${PASS} Connected as: ${row.current_user}`);
  console.log(`${PASS} Database: ${row.current_database}`);
  console.log(`${INFO} PG: ${row.version.split(",")[0]}`);
} catch (err) {
  console.log(`${FAIL} Connection failed: ${err.message}`);
  process.exit(1);
}

// ── 2. Role inheritance ─────────────────────────────────────
section("Role inheritance");

try {
  const roles = await query(`
    SELECT r.rolname,
           ARRAY(SELECT b.rolname FROM pg_catalog.pg_auth_members m
                 JOIN pg_catalog.pg_roles b ON b.oid = m.roleid
                 WHERE m.member = r.oid) AS member_of
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user
  `);
  const row = roles.rows[0];
  if (row) {
    const inherited = row.member_of || [];
    console.log(`${PASS} ${row.rolname} inherits from: ${inherited.length > 0 ? inherited.join(", ") : "(none)"}`);
    if (!inherited.includes("linkedin_agent_app")) {
      console.log(`${FAIL} Missing inheritance: linkedin_agent_app`);
      console.log(`   Fix: GRANT linkedin_agent_app TO ${row.rolname};`);
      exitCode = 1;
    }
  }
} catch (err) {
  console.log(`${FAIL} Role check failed: ${err.message}`);
}

// ── 3. Table access ─────────────────────────────────────────
section("Table access (platform tables above RLS)");

for (const table of ["tenants", "memberships", "invites"]) {
  try {
    const result = await query(`SELECT count(*) AS n FROM ${table}`);
    console.log(`${PASS} ${table}: ${result.rows[0].n} rows`);
  } catch (err) {
    console.log(`${FAIL} ${table}: ${err.message}`);
    exitCode = 1;
  }
}

// ── 4. Tenants ──────────────────────────────────────────────
section("Tenants");

let tenants;
try {
  tenants = await query("SELECT id, slug, name, status FROM tenants ORDER BY created_at");
  if (tenants.rows.length === 0) {
    console.log(`${WARN} No tenants exist in this database`);
  } else {
    for (const t of tenants.rows) {
      const flag = t.status === "active" ? PASS : WARN;
      console.log(`${flag} ${t.slug} (${t.id}) — status: ${t.status}`);
    }
  }
} catch (err) {
  console.log(`${FAIL} Cannot read tenants: ${err.message}`);
  exitCode = 1;
}

// ── 5. Memberships ──────────────────────────────────────────
section("Memberships");

let memberships;
try {
  memberships = await query(`
    SELECT m.auth_provider, m.auth_sub, m.role::text, t.slug
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    ORDER BY t.slug
  `);
  if (memberships.rows.length === 0) {
    console.log(`${WARN} No memberships exist — no user can resolve a tenant`);
  } else {
    for (const m of memberships.rows) {
      console.log(`${PASS} ${m.slug} | ${m.auth_provider} | ${m.auth_sub.substring(0, 30)}... | role: ${m.role}`);
    }
  }
} catch (err) {
  console.log(`${FAIL} Cannot read memberships: ${err.message}`);
  exitCode = 1;
}

// ── 6. Invites ──────────────────────────────────────────────
section("Pending invites");

try {
  const invites = await query(`
    SELECT i.email, i.role::text, i.status, t.slug
    FROM invites i
    JOIN tenants t ON t.id = i.tenant_id
    WHERE i.status = 'pending'
    ORDER BY i.created_at
  `);
  if (invites.rows.length === 0) {
    console.log(`${INFO} No pending invites`);
  } else {
    for (const inv of invites.rows) {
      console.log(`${INFO} ${inv.email} → ${inv.slug} (role: ${inv.role})`);
    }
  }
} catch (err) {
  console.log(`${FAIL} Cannot read invites: ${err.message}`);
}

// ── 7. RLS-protected table spot check ───────────────────────
section("RLS spot check (should return 0 without tenant context)");

for (const table of ["topics", "posts", "agent_state", "credentials"]) {
  try {
    const result = await query(`SELECT count(*) AS n FROM ${table}`);
    const n = parseInt(result.rows[0].n);
    if (n > 0) {
      console.log(`${WARN} ${table}: ${n} rows visible WITHOUT tenant context — RLS may not be enforced`);
    } else {
      console.log(`${PASS} ${table}: 0 rows (RLS is blocking — correct)`);
    }
  } catch (err) {
    console.log(`${FAIL} ${table}: ${err.message}`);
  }
}

// ── 8. Simulate resolver for each known provider+sub ────────
section("Resolver simulation");

if (memberships && memberships.rows.length > 0) {
  for (const m of memberships.rows) {
    const result = await findTenantByAuthIdentity(m.auth_provider, m.auth_sub);
    if (result) {
      console.log(`${PASS} findTenantByAuthIdentity("${m.auth_provider}", "${m.auth_sub.substring(0, 20)}...") → ${result.slug} (role: ${result.role})`);
    } else {
      console.log(`${FAIL} findTenantByAuthIdentity("${m.auth_provider}", "${m.auth_sub.substring(0, 20)}...") → null`);
      exitCode = 1;
    }
  }
} else {
  console.log(`${WARN} No memberships to test — resolver will always return null`);
}

// ── 9. Offer fix ────────────────────────────────────────────
if (FIX_MODE && tenants && tenants.rows.length > 0 && memberships && memberships.rows.length === 0) {
  section("Interactive fix");
  console.log(`\nNo memberships found. Create one now.\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log("Available tenants:");
  tenants.rows.forEach((t, i) => console.log(`  ${i + 1}) ${t.slug} (${t.id})`));

  const tenantIdx = parseInt(await ask("\nTenant number: ")) - 1;
  const tenant = tenants.rows[tenantIdx];
  if (!tenant) {
    console.log("Invalid selection.");
    rl.close();
    process.exit(1);
  }

  const provider = await ask("Auth provider (auth0 / workos): ");
  const sub = await ask("Auth sub (e.g. auth0|abc123): ");
  const role = await ask("Role (owner / editor / viewer): ");

  console.log(`\nCreating membership:`);
  console.log(`  Tenant:   ${tenant.slug} (${tenant.id})`);
  console.log(`  Provider: ${provider}`);
  console.log(`  Sub:      ${sub}`);
  console.log(`  Role:     ${role}`);

  const confirm = await ask("\nProceed? (yes/no): ");
  if (confirm.toLowerCase() === "yes") {
    try {
      await query(
        `INSERT INTO memberships (tenant_id, auth_provider, auth_sub, role)
         VALUES ($1, $2::auth_provider, $3, $4::member_role)`,
        [tenant.id, provider, sub, role]
      );
      console.log(`${PASS} Membership created. Refresh the browser.`);
    } catch (err) {
      console.log(`${FAIL} Insert failed: ${err.message}`);
      exitCode = 1;
    }
  } else {
    console.log("Cancelled.");
  }
  rl.close();
}

// ── Summary ─────────────────────────────────────────────────
section("Summary");
if (exitCode === 0) {
  console.log(`${PASS} All checks passed. If users still see "No Membership",`);
  console.log(`   check PM2 logs for the sub Auth0 is sending and compare`);
  console.log(`   against the memberships table.\n`);
} else {
  console.log(`${FAIL} Issues found above. Run with --fix to repair interactively.\n`);
}

process.exit(exitCode);
