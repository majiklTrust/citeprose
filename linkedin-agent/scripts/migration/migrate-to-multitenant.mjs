#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// migrate-to-multitenant.mjs
// ═══════════════════════════════════════════════════════════════
// One-shot migration: single linkedin-agent.sqlite → multi-tenant
// silo (platform.sqlite + tenants/<tenant_id>.sqlite). Each step
// is idempotent — re-running skips already-completed work.
//
// Usage:
//   node migrate-to-multitenant.mjs --auth-sub auth0|abc123 [opts]
//   node migrate-to-multitenant.mjs --auth-sub auth0|abc123 --dry-run
//
// See scripts/migration/README.md for full options and step-by-step
// description. Run --help for the short reference.
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// better-sqlite3 is loaded lazily inside main() so that --help
// and dry-run inspection work even in environments where the
// dependency is not installed (e.g., a fresh checkout before
// `npm ci`). Module-level variable, set once at startup.
let Database = null;

// ── Hardcoded constants (intentional, with rationale) ──────
//
// HKDF info string is a version marker for credential encryption.
// Changing this rotates the derivation scheme — existing
// credentials must be re-encrypted before this changes.
const HKDF_INFO = "credential-encryption-v1";

// AES-256-GCM byte sizes are protocol-defined, never change.
const AES_KEY_LENGTH_BYTES = 32;
const AES_IV_LENGTH_BYTES = 12;
const AES_AUTH_TAG_LENGTH_BYTES = 16;

// PBKDF2 parameters MUST match the existing platform encryption
// scheme (src/services/encryption.js) — used only for decrypting
// the existing platform-level credentials during migration.
// Changing these values would break decryption of pre-existing
// credentials.
const PLATFORM_PBKDF2_ITERATIONS = 200000;
const PLATFORM_PBKDF2_DIGEST = "sha256";

// Tables to copy verbatim from the source DB into the tenant DB.
// These tables exist in both pre- and post-migration schemas
// with identical structure, so a CREATE TABLE AS SELECT works.
const TABLES_TO_COPY = ["posts", "agent_state", "activity_log", "articles"];

// Credential keys to migrate from .env into the tenant credentials
// table. Each is encrypted under the derived per-tenant key.
// LINKEDIN_PERSON_URN is not strictly secret but lives here for
// cohesion — all per-tenant identity material in one place.
const ENV_CREDENTIALS = [
  { envName: "ANTHROPIC_API_KEY_ENCRYPTED", credKey: "anthropic_api_key", isPlatformEncrypted: true },
  { envName: "LINKEDIN_ACCESS_TOKEN", credKey: "linkedin_access_token", isPlatformEncrypted: false },
  { envName: "LINKEDIN_PERSON_URN", credKey: "linkedin_person_urn", isPlatformEncrypted: false }
];

// ── CLI parsing ────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    authSub: null,
    authProvider: "auth0",
    tenantId: "tenant_001",
    tenantName: null,
    sourceDb: "./data/agent.db",
    platformDb: "./data/agent.platform.sqlite",
    tenantsDir: "./data/tenants",
    envFile: "./.env",
    backupSuffix: "pre-multitenant.bak",
    dryRun: false,
    verbose: false
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--auth-sub": opts.authSub = next(); break;
      case "--auth-provider": opts.authProvider = next(); break;
      case "--tenant-id": opts.tenantId = next(); break;
      case "--tenant-name": opts.tenantName = next(); break;
      case "--source-db": opts.sourceDb = next(); break;
      case "--platform-db": opts.platformDb = next(); break;
      case "--tenants-dir": opts.tenantsDir = next(); break;
      case "--env-file": opts.envFile = next(); break;
      case "--backup-suffix": opts.backupSuffix = next(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }
  if (!opts.authSub) {
    console.error("ERROR: --auth-sub is required");
    printHelp();
    process.exit(2);
  }
  if (!opts.tenantName) {
    opts.tenantName = `Tenant for ${opts.authSub}`;
  }
  return opts;
}

function printHelp() {
  // The header comment block at the top of this file is the
  // canonical reference. Print a short pointer instead of
  // duplicating it.
  console.log("See header comment in this file for full usage.");
  console.log("Required: --auth-sub <auth0|abc123 or workos|abc123>");
}

// ── Logging ────────────────────────────────────────────────
const ICON = { step: "▶", ok: "✓", skip: "·", warn: "⚠", err: "✗", dry: "◌" };
function log(level, msg) {
  const icon = ICON[level] || " ";
  const prefix = `  ${icon}`;
  console.log(`${prefix} ${msg}`);
}
function step(n, name) { console.log(`\n── Step ${n}: ${name} ──`); }
function dryNote(opts) { return opts.dryRun ? " [DRY-RUN]" : ""; }

// ── Encryption helpers ─────────────────────────────────────

// Decrypts a value that was encrypted with the platform-level
// scheme used in src/services/encryption.js: PBKDF2-derived key
// from ENCRYPTION_SECRET + ENCRYPTION_SALT, AES-256-GCM, and
// the on-disk format "iv_hex:authTag_hex:ciphertext_hex".
function decryptPlatformCredential(envValue, encryptionSecret, encryptionSalt) {
  const parts = envValue.split(":");
  if (parts.length !== 3) {
    throw new Error("Platform credential is not in iv:authTag:ciphertext format");
  }
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const ciphertext = Buffer.from(parts[2], "hex");

  const key = crypto.pbkdf2Sync(
    encryptionSecret,
    encryptionSalt,
    PLATFORM_PBKDF2_ITERATIONS,
    AES_KEY_LENGTH_BYTES,
    PLATFORM_PBKDF2_DIGEST
  );

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// Derives a per-tenant encryption key from the platform master
// secret using HKDF-SHA256. Tenant ID is the salt — guarantees
// each tenant gets a unique key. Info string is versioned so
// the scheme can be rotated without breaking existing rows.
function deriveTenantKey(masterSecret, tenantId) {
  const ikm = Buffer.from(masterSecret, "utf8");
  const salt = Buffer.from(tenantId, "utf8");
  const info = Buffer.from(HKDF_INFO, "utf8");
  // crypto.hkdfSync returns an ArrayBuffer; wrap to Buffer.
  const derived = crypto.hkdfSync("sha256", ikm, salt, info, AES_KEY_LENGTH_BYTES);
  return Buffer.from(derived);
}

// Encrypts plaintext under a derived tenant key. Output format
// is raw bytes: iv (12) || authTag (16) || ciphertext. Stored
// directly in the credentials.value_enc BLOB column.
function encryptTenantCredential(plaintext, tenantKey) {
  const iv = crypto.randomBytes(AES_IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", tenantKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

// ── .env reading ───────────────────────────────────────────
// Minimal parser. Splits on first '='. Strips matched quotes.
// Same approach used by deploy/06-application.sh.
function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Env file not found: ${filePath}`);
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const env = {};
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1);
    if (value.length >= 2) {
      const first = value[0], last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    env[key] = value;
  }
  return env;
}

// ── Step implementations ───────────────────────────────────

async function step1_verifyPreconditions(opts) {
  step(1, "Verify preconditions");
  const checks = [
    { path: opts.sourceDb, label: "source database" },
    { path: opts.envFile, label: "env file" }
  ];
  for (const c of checks) {
    if (!fs.existsSync(c.path)) {
      log("err", `Missing ${c.label}: ${c.path}`);
      process.exit(1);
    }
    log("ok", `${c.label}: ${c.path}`);
  }

  const env = readEnvFile(opts.envFile);
  const required = ["ENCRYPTION_SECRET", "ENCRYPTION_SALT"];
  for (const r of required) {
    if (!env[r]) {
      log("err", `Missing ${r} in ${opts.envFile}`);
      process.exit(1);
    }
  }
  log("ok", "ENCRYPTION_SECRET and ENCRYPTION_SALT present");
  return env;
}

function step2_backupSource(opts) {
  step(2, "Backup source database");
  const backupPath = `${opts.sourceDb}.${opts.backupSuffix}`;
  if (fs.existsSync(backupPath)) {
    log("skip", `Backup already exists: ${backupPath}`);
    return backupPath;
  }
  if (opts.dryRun) {
    log("dry", `Would copy ${opts.sourceDb} → ${backupPath}`);
    return backupPath;
  }
  fs.copyFileSync(opts.sourceDb, backupPath);
  log("ok", `Backed up to ${backupPath}`);
  return backupPath;
}

function applySqlFile(db, sqlPath, opts, label) {
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`SQL file not found: ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  if (opts.dryRun) {
    log("dry", `Would apply ${label}`);
    return;
  }
  db.exec(sql);
  log("ok", `Applied ${label}`);
}

function step3_createPlatformDb(opts) {
  step(3, "Create platform database");
  const exists = fs.existsSync(opts.platformDb);
  if (opts.dryRun) {
    if (exists) log("skip", `Platform DB exists: ${opts.platformDb}`);
    else log("dry", `Would create ${opts.platformDb}`);
    return null;
  }
  const db = new Database(opts.platformDb);
  if (exists) log("skip", `Platform DB existed; opened for updates`);
  else log("ok", `Created ${opts.platformDb}`);
  const sqlPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "sql",
    "platform-schema.sql"
  );
  applySqlFile(db, sqlPath, opts, "platform-schema.sql");
  return db;
}

function step4_createTenantRow(platformDb, opts) {
  step(4, "Insert tenant row");
  if (opts.dryRun || !platformDb) {
    log("dry", `Would insert tenant ${opts.tenantId} (${opts.tenantName})`);
    return;
  }
  const existing = platformDb
    .prepare("SELECT id FROM tenants WHERE id = ?")
    .get(opts.tenantId);
  if (existing) {
    log("skip", `Tenant row already exists: ${opts.tenantId}`);
    return;
  }
  const tenantDbPath = path.join(opts.tenantsDir, `${opts.tenantId}.sqlite`);
  platformDb
    .prepare(
      `INSERT INTO tenants (id, name, status, db_path, created_at, created_by)
       VALUES (?, ?, 'active', ?, datetime('now'), ?)`
    )
    .run(opts.tenantId, opts.tenantName, tenantDbPath, opts.authSub);
  log("ok", `Inserted tenant: ${opts.tenantId}`);
}

function step5_createMembership(platformDb, opts) {
  step(5, "Insert membership");
  if (opts.dryRun || !platformDb) {
    log("dry", `Would insert membership ${opts.authProvider}/${opts.authSub} → ${opts.tenantId}`);
    return;
  }
  const existing = platformDb
    .prepare(
      "SELECT id FROM memberships WHERE auth_provider = ? AND auth_sub = ?"
    )
    .get(opts.authProvider, opts.authSub);
  if (existing) {
    log("skip", "Membership already exists");
    return;
  }
  const id = `mem_${crypto.randomBytes(8).toString("hex")}`;
  platformDb
    .prepare(
      `INSERT INTO memberships (id, tenant_id, auth_provider, auth_sub, role, created_at)
       VALUES (?, ?, ?, ?, 'owner', datetime('now'))`
    )
    .run(id, opts.tenantId, opts.authProvider, opts.authSub);
  log("ok", `Inserted membership: ${opts.authProvider}/${opts.authSub}`);
}

function step6_createTenantDb(opts) {
  step(6, "Create tenant database file");
  if (!fs.existsSync(opts.tenantsDir)) {
    if (opts.dryRun) {
      log("dry", `Would mkdir ${opts.tenantsDir}`);
    } else {
      fs.mkdirSync(opts.tenantsDir, { recursive: true });
      log("ok", `Created ${opts.tenantsDir}`);
    }
  }
  const tenantDbPath = path.join(opts.tenantsDir, `${opts.tenantId}.sqlite`);
  const exists = fs.existsSync(tenantDbPath);
  if (opts.dryRun) {
    if (exists) log("skip", `Tenant DB exists: ${tenantDbPath}`);
    else log("dry", `Would create ${tenantDbPath}`);
    return null;
  }
  const db = new Database(tenantDbPath);
  if (exists) log("skip", `Tenant DB existed; opened for updates`);
  else log("ok", `Created ${tenantDbPath}`);
  return db;
}

function step7_copyExistingTables(sourceDbPath, tenantDb, opts) {
  step(7, "Copy existing tables into tenant DB");
  if (opts.dryRun || !tenantDb) {
    log("dry", `Would copy tables: ${TABLES_TO_COPY.join(", ")}`);
    return;
  }
  // Use ATTACH to pull rows from the source file directly.
  tenantDb.exec(`ATTACH DATABASE '${sourceDbPath}' AS src`);
  try {
    for (const table of TABLES_TO_COPY) {
      const dest = tenantDb
        .prepare(`SELECT count(*) AS n FROM ${table}`)
        .get();
      if (dest && dest.n > 0) {
        log("skip", `${table}: ${dest.n} rows already present`);
        continue;
      }
      tenantDb.exec(`CREATE TABLE IF NOT EXISTS ${table} AS SELECT * FROM src.${table} WHERE 0`);
      tenantDb.exec(`INSERT INTO ${table} SELECT * FROM src.${table}`);
      const after = tenantDb.prepare(`SELECT count(*) AS n FROM ${table}`).get();
      log("ok", `${table}: copied ${after.n} rows`);
    }
  } finally {
    tenantDb.exec("DETACH DATABASE src");
  }
}

function step8_applyTenantSchemaAdditions(tenantDb, opts) {
  step(8, "Apply tenant schema additions");
  if (opts.dryRun || !tenantDb) {
    log("dry", "Would apply tenant-schema-additions.sql");
    return;
  }
  const sqlPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "sql",
    "tenant-schema-additions.sql"
  );
  applySqlFile(tenantDb, sqlPath, opts, "tenant-schema-additions.sql");
}

async function importJsModule(modulePath, exportName) {
  // Dynamic import — works for both .js and .mjs files. The
  // existing src/config/topics.js and feeds.js are ESM with
  // top-level `export const`, so this picks them up cleanly.
  const fileUrl = pathToFileURL(path.resolve(modulePath)).href;
  const mod = await import(fileUrl);
  return mod[exportName];
}

async function step9_seedTopics(tenantDb, opts) {
  step(9, "Seed topics from src/config/topics.js");
  const topicsPath = "./src/config/topics.js";
  if (!fs.existsSync(topicsPath)) {
    log("warn", `Topics file not found: ${topicsPath} — skipping`);
    return;
  }
  const topics = await importJsModule(topicsPath, "TOPICS");
  if (!Array.isArray(topics)) {
    log("err", "TOPICS export is not an array");
    return;
  }
  if (opts.dryRun || !tenantDb) {
    log("dry", `Would insert ${topics.length} topics`);
    return;
  }
  const existing = tenantDb.prepare("SELECT count(*) AS n FROM topics").get();
  if (existing && existing.n > 0) {
    log("skip", `topics: ${existing.n} rows already present`);
    return;
  }
  const insert = tenantDb.prepare(
    `INSERT INTO topics
       (id, name, hashtags_json, system_context, content_angles_json,
        enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`
  );
  const insertMany = tenantDb.transaction((items) => {
    items.forEach((t, i) => {
      insert.run(
        t.id,
        t.name,
        JSON.stringify(t.hashtags || []),
        t.systemContext || "",
        JSON.stringify(t.contentAngles || []),
        i
      );
    });
  });
  insertMany(topics);
  log("ok", `Inserted ${topics.length} topics`);
}

async function step10_seedFeeds(tenantDb, opts) {
  step(10, "Seed feeds from src/config/feeds.js");
  const feedsPath = "./src/config/feeds.js";
  if (!fs.existsSync(feedsPath)) {
    log("warn", `Feeds file not found: ${feedsPath} — skipping`);
    return;
  }
  const feeds = await importJsModule(feedsPath, "FEEDS");
  if (!Array.isArray(feeds)) {
    log("err", "FEEDS export is not an array");
    return;
  }
  if (opts.dryRun || !tenantDb) {
    log("dry", `Would insert ${feeds.length} feeds`);
    return;
  }
  const existing = tenantDb.prepare("SELECT count(*) AS n FROM feeds").get();
  if (existing && existing.n > 0) {
    log("skip", `feeds: ${existing.n} rows already present`);
    return;
  }
  const insert = tenantDb.prepare(
    `INSERT INTO feeds
       (url, name, topic_ids_json, tier, refresh_minutes, enabled,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
  );
  const insertMany = tenantDb.transaction((items) => {
    items.forEach((f) => {
      insert.run(
        f.url,
        f.name,
        JSON.stringify(f.topicIds || []),
        f.tier || "primary",
        f.refreshMinutes || 120
      );
    });
  });
  insertMany(feeds);
  log("ok", `Inserted ${feeds.length} feeds`);
}

function step11_migrateCredentials(tenantDb, env, opts) {
  step(11, "Migrate credentials from .env into tenant credentials table");
  const tenantKey = deriveTenantKey(env.ENCRYPTION_SECRET, opts.tenantId);

  for (const cred of ENV_CREDENTIALS) {
    const envValue = env[cred.envName];
    if (!envValue) {
      log("warn", `${cred.envName} not in .env — skipping`);
      continue;
    }

    let plaintext;
    try {
      if (cred.isPlatformEncrypted) {
        plaintext = decryptPlatformCredential(envValue, env.ENCRYPTION_SECRET, env.ENCRYPTION_SALT);
      } else {
        plaintext = envValue;
      }
    } catch (e) {
      log("err", `Failed to decrypt ${cred.envName}: ${e.message}`);
      continue;
    }

    if (opts.dryRun || !tenantDb) {
      log("dry", `Would store ${cred.credKey} (${plaintext.length} bytes plaintext)`);
      continue;
    }

    const existing = tenantDb
      .prepare("SELECT key FROM credentials WHERE key = ?")
      .get(cred.credKey);
    if (existing) {
      log("skip", `Credential already present: ${cred.credKey}`);
      continue;
    }

    const ciphertext = encryptTenantCredential(plaintext, tenantKey);
    tenantDb
      .prepare(
        `INSERT INTO credentials (key, value_enc, encryption_version, updated_at)
         VALUES (?, ?, 1, datetime('now'))`
      )
      .run(cred.credKey, ciphertext);
    log("ok", `Stored: ${cred.credKey}`);
  }
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Multi-tenant migration${dryNote(opts)}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Source DB:    ${opts.sourceDb}`);
  console.log(`  Platform DB:  ${opts.platformDb}`);
  console.log(`  Tenant DB:    ${opts.tenantsDir}/${opts.tenantId}.sqlite`);
  console.log(`  Auth provider: ${opts.authProvider}`);
  console.log(`  Auth sub:      ${opts.authSub}`);
  console.log(`  Tenant name:  ${opts.tenantName}`);

  // Load better-sqlite3 only when actually needed (not dry-run).
  // This lets the script run --help and --dry-run from a clean
  // checkout without `npm ci` first.
  if (!opts.dryRun) {
    try {
      const mod = await import("better-sqlite3");
      Database = mod.default;
    } catch (e) {
      console.error("\nFATAL: better-sqlite3 not available.");
      console.error("Run from the linkedin-agent project root after `npm ci`.");
      console.error(`Underlying error: ${e.message}`);
      process.exit(1);
    }
  }

  const env = await step1_verifyPreconditions(opts);
  step2_backupSource(opts);
  const platformDb = step3_createPlatformDb(opts);
  step4_createTenantRow(platformDb, opts);
  step5_createMembership(platformDb, opts);
  if (platformDb) platformDb.close();

  const tenantDb = step6_createTenantDb(opts);
  step7_copyExistingTables(opts.sourceDb, tenantDb, opts);
  step8_applyTenantSchemaAdditions(tenantDb, opts);
  await step9_seedTopics(tenantDb, opts);
  await step10_seedFeeds(tenantDb, opts);
  step11_migrateCredentials(tenantDb, env, opts);
  if (tenantDb) tenantDb.close();

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Migration complete${dryNote(opts)}`);
  console.log("═══════════════════════════════════════════════════════════");
  if (opts.dryRun) {
    console.log("\n  Dry run only — no files were written.");
    console.log("  Re-run without --dry-run to apply changes.");
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
