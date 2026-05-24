#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// sqlite-to-postgres.mjs — one-shot, local-only data migration
// ═══════════════════════════════════════════════════════════════
// Reads ./data/agent.db (SQLite, single-tenant) and writes the
// data into the multi-tenant PostgreSQL schema from drop 0.45.1.4.
//
// LOCAL-ONLY. THROWAWAY. Run once to bootstrap the postgres
// database, then never again. This script is not part of the
// application's ongoing tooling.
//
// Connects to PostgreSQL as the `migrator` role (BYPASSRLS) so
// it can write across the schema without setting per-row tenant
// context. The application runtime role (linkedin_agent_app)
// is NOT used here.
//
// Usage:
//   node scripts/migration/sqlite-to-postgres.mjs --auth-sub "auth0|YOUR_SUB"
//   node scripts/migration/sqlite-to-postgres.mjs --auth-sub "auth0|YOUR_SUB" --dry-run
//
// Required env: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
//   ENCRYPTION_SECRET ENCRYPTION_SALT
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// Lazy-loaded so --help and --dry-run work without npm install
let Database = null;
let pg = null;

// ── Encryption constants (must match prior migration script) ──
const HKDF_INFO = "credential-encryption-v1";
const AES_KEY_LENGTH_BYTES = 32;
const AES_IV_LENGTH_BYTES = 12;
const PLATFORM_PBKDF2_ITERATIONS = 200000;
const PLATFORM_PBKDF2_DIGEST = "sha256";

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
    tenantSlug: "tenant_001",
    tenantName: "Progress Tenant",
    sourceDb: "./data/agent.db",
    envFile: "./.env",
    dryRun: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    switch (a) {
      case "--auth-sub": opts.authSub = next(); break;
      case "--auth-provider": opts.authProvider = next(); break;
      case "--tenant-slug": opts.tenantSlug = next(); break;
      case "--tenant-name": opts.tenantName = next(); break;
      case "--source-db": opts.sourceDb = next(); break;
      case "--env-file": opts.envFile = next(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--help": case "-h":
        console.log("Usage: node sqlite-to-postgres.mjs --auth-sub <sub> [--dry-run]");
        console.log("Required env: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE ENCRYPTION_SECRET ENCRYPTION_SALT");
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  if (!opts.authSub) {
    console.error("ERROR: --auth-sub required (e.g., 'auth0|abc123')"); process.exit(2);
  }
  return opts;
}

// ── Logging ────────────────────────────────────────────────
const ICON = { ok: "✓", skip: "·", warn: "⚠", err: "✗", dry: "◌" };
const log = (lvl, msg) => console.log(`  ${ICON[lvl] || " "} ${msg}`);
const step = (n, name) => console.log(`\n── Step ${n}: ${name} ──`);

// ── .env reader ────────────────────────────────────────────
function readEnvFile(p) {
  if (!fs.existsSync(p)) throw new Error(`Env file not found: ${p}`);
  const env = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    let v = line.slice(i + 1);
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
      v = v.slice(1, -1);
    }
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

// ── Encryption helpers ─────────────────────────────────────
function decryptPlatformCredential(envValue, secret, salt) {
  const [ivHex, tagHex, ctHex] = envValue.split(":");
  if (!ctHex) throw new Error("Bad platform credential format");
  const key = crypto.pbkdf2Sync(secret, salt, PLATFORM_PBKDF2_ITERATIONS, AES_KEY_LENGTH_BYTES, PLATFORM_PBKDF2_DIGEST);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

function deriveTenantKey(masterSecret, tenantUuid) {
  const derived = crypto.hkdfSync("sha256",
    Buffer.from(masterSecret, "utf8"),
    Buffer.from(tenantUuid, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES);
  return Buffer.from(derived);
}

function encryptTenantCredential(plaintext, tenantKey) {
  const iv = crypto.randomBytes(AES_IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", tenantKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

// ── SQLite helpers (timestamp + JSON) ──────────────────────
// SQLite stores naive datetime strings. The application has been
// writing UTC (confirmed by `posted_at + "Z"` pattern in scheduler).
// Append Z to make Postgres TIMESTAMPTZ accept them as UTC.
function sqliteToUtc(s) {
  if (s == null) return null;
  return s.endsWith("Z") ? s : s.replace(" ", "T") + "Z";
}

function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── Main migration ─────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  SQLite → PostgreSQL migration${opts.dryRun ? " [DRY-RUN]" : ""}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Source:    ${opts.sourceDb}`);
  console.log(`  Tenant:    ${opts.tenantSlug} (${opts.tenantName})`);
  console.log(`  Auth:      ${opts.authProvider} / ${opts.authSub}`);

  // ── Step 1: preconditions ──
  step(1, "Verify preconditions");
  if (!fs.existsSync(opts.sourceDb)) { log("err", `Missing ${opts.sourceDb}`); process.exit(1); }
  log("ok", `source DB: ${opts.sourceDb}`);
  const env = readEnvFile(opts.envFile);
  for (const k of ["ENCRYPTION_SECRET", "ENCRYPTION_SALT", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    if (!env[k] && !process.env[k]) { log("err", `Missing ${k}`); process.exit(1); }
  }
  log("ok", "encryption + Postgres env vars present");

  // Lazy-load drivers (skipped for dry-run)
  if (!opts.dryRun) {
    try { Database = (await import("better-sqlite3")).default; } catch (e) { log("err", `better-sqlite3: ${e.message}`); process.exit(1); }
    try { pg = await import("pg"); } catch (e) { log("err", `pg: ${e.message}. Run: npm install pg`); process.exit(1); }
  }

  // ── Step 2: open connections ──
  step(2, "Open SQLite + Postgres connections");
  let sqlite = null, client = null;
  if (!opts.dryRun) {
    sqlite = new Database(opts.sourceDb, { readonly: true });
    log("ok", "SQLite opened (readonly)");
    const { Client } = pg;
    client = new Client({
      host: env.PGHOST || process.env.PGHOST,
      port: parseInt(env.PGPORT || process.env.PGPORT, 10),
      user: env.PGUSER || process.env.PGUSER,
      password: env.PGPASSWORD || process.env.PGPASSWORD,
      database: env.PGDATABASE || process.env.PGDATABASE
    });
    await client.connect();
    log("ok", "Postgres connected");
    // Verify schema
    const r = await client.query("SELECT to_regclass('public.tenants') AS t");
    if (!r.rows[0].t) { log("err", "tenants table missing — run 0.45.1.4 DDL first"); process.exit(1); }
    log("ok", "schema present");
  } else {
    log("dry", "would open SQLite + Postgres");
  }

  // ── Step 3: insert tenant ──
  step(3, "Insert tenant row");
  let tenantId = "00000000-0000-0000-0000-000000000000";
  if (!opts.dryRun) {
    const r = await client.query(
      `INSERT INTO tenants (slug, name, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [opts.tenantSlug, opts.tenantName, opts.authSub]
    );
    tenantId = r.rows[0].id;
    log("ok", `tenant id: ${tenantId}`);
  } else {
    log("dry", `would insert tenant ${opts.tenantSlug}`);
  }

  // ── Step 4: insert membership ──
  step(4, "Insert membership");
  if (!opts.dryRun) {
    await client.query(
      `INSERT INTO memberships (tenant_id, auth_provider, auth_sub)
       VALUES ($1, $2::auth_provider, $3) ON CONFLICT (auth_provider, auth_sub) DO NOTHING`,
      [tenantId, opts.authProvider, opts.authSub]
    );
    log("ok", `membership: ${opts.authProvider}/${opts.authSub}`);
  } else {
    log("dry", "would insert membership");
  }

  // ── Step 5: seed topics ──
  step(5, "Seed topics from src/config/topics.js");
  const topicsPath = "./src/config/topics.js";
  let slugToId = new Map();
  if (!fs.existsSync(topicsPath)) {
    log("warn", `${topicsPath} not found — skipping topics`);
  } else {
    const topicsMod = await import(pathToFileURL(path.resolve(topicsPath)).href);
    const topics = topicsMod.TOPICS || [];
    if (opts.dryRun) {
      log("dry", `would insert ${topics.length} topics`);
    } else {
      for (const t of topics) {
        const r = await client.query(
          `INSERT INTO topics (tenant_id, slug, name, hashtags, system_context, content_angles)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
           ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [tenantId, t.id, t.name, JSON.stringify(t.hashtags || []),
           t.systemContext || "", JSON.stringify(t.contentAngles || [])]
        );
        slugToId.set(t.id, r.rows[0].id);
      }
      log("ok", `inserted ${topics.length} topics`);
    }
  }

  // ── Step 6: seed feeds ──
  step(6, "Seed feeds from src/config/feeds.js");
  const feedsPath = "./src/config/feeds.js";
  if (!fs.existsSync(feedsPath)) {
    log("warn", `${feedsPath} not found — skipping feeds`);
  } else {
    const feedsMod = await import(pathToFileURL(path.resolve(feedsPath)).href);
    const feeds = feedsMod.FEEDS || [];
    if (opts.dryRun) {
      log("dry", `would insert ${feeds.length} feeds`);
    } else {
      for (const f of feeds) {
        await client.query(
          `INSERT INTO feeds (tenant_id, url, name, topic_slugs, tier, refresh_minutes)
           VALUES ($1, $2, $3, $4::jsonb, $5::feed_tier, $6)
           ON CONFLICT (tenant_id, url) DO NOTHING`,
          [tenantId, f.url, f.name, JSON.stringify(f.topicIds || []),
           f.tier || "primary", f.refreshMinutes || 120]
        );
      }
      log("ok", `inserted ${feeds.length} feeds`);
    }
  }

  // ── Step 7: copy articles ──
  step(7, "Copy articles");
  if (!opts.dryRun) {
    const rows = sqlite.prepare("SELECT * FROM articles").all();
    for (const r of rows) {
      await client.query(
        `INSERT INTO articles (tenant_id, feed_name, feed_tier, topic_slugs, title, link, summary, published_at, fetched_at, content_hash)
         VALUES ($1, $2, $3::feed_tier, $4::jsonb, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10)
         ON CONFLICT (tenant_id, link) DO NOTHING`,
        [tenantId, r.feed_name, r.feed_tier,
         JSON.stringify(parseJson(r.topic_ids, [])),
         r.title, r.link, r.summary,
         sqliteToUtc(r.published_at), sqliteToUtc(r.fetched_at), r.content_hash]
      );
    }
    log("ok", `copied ${rows.length} articles`);
  } else { log("dry", "would copy articles"); }

  // ── Step 8: copy posts ──
  step(8, "Copy posts");
  if (!opts.dryRun) {
    const rows = sqlite.prepare("SELECT * FROM posts").all();
    let copied = 0, skipped = 0;
    for (const r of rows) {
      const topicIntId = slugToId.get(r.topic_id) || null;
      if (r.topic_id && !topicIntId) {
        log("warn", `post ${r.id}: unknown topic slug "${r.topic_id}" — topic_id will be NULL`);
      }
      await client.query(
        `INSERT INTO posts (tenant_id, topic_id, title, content, hashtags, status, linkedin_id, created_at, scheduled_for, posted_at, error_message, news_context)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::post_status, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11, $12::jsonb)`,
        [tenantId, topicIntId, r.title, r.content,
         JSON.stringify(parseJson(r.hashtags, [])),
         r.status || "draft", r.linkedin_id,
         sqliteToUtc(r.created_at), sqliteToUtc(r.scheduled_for), sqliteToUtc(r.posted_at),
         r.error_message,
         r.news_context ? JSON.stringify(parseJson(r.news_context, null)) : null]
      );
      copied++;
    }
    log("ok", `copied ${copied} posts (${skipped} skipped)`);
    // Reset IDENTITY sequence
    await client.query(`SELECT setval(pg_get_serial_sequence('posts','id'), COALESCE((SELECT max(id) FROM posts), 1))`);
  } else { log("dry", "would copy posts"); }

  // ── Step 9: copy agent_state ──
  step(9, "Copy agent_state");
  if (!opts.dryRun) {
    const rows = sqlite.prepare("SELECT * FROM agent_state").all();
    for (const r of rows) {
      await client.query(
        `INSERT INTO agent_state (tenant_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [tenantId, r.key, r.value]
      );
    }
    log("ok", `copied ${rows.length} agent_state rows`);
  } else { log("dry", "would copy agent_state"); }

  // ── Step 10: copy activity_log ──
  step(10, "Copy activity_log");
  if (!opts.dryRun) {
    const rows = sqlite.prepare("SELECT * FROM activity_log").all();
    for (const r of rows) {
      await client.query(
        `INSERT INTO activity_log (tenant_id, timestamp, level, action, details)
         VALUES ($1, $2::timestamptz, $3::log_level, $4, $5::jsonb)`,
        [tenantId, sqliteToUtc(r.timestamp), r.level, r.action,
         r.details ? JSON.stringify(parseJson(r.details, null)) : null]
      );
    }
    log("ok", `copied ${rows.length} activity_log rows`);
    await client.query(`SELECT setval(pg_get_serial_sequence('activity_log','id'), COALESCE((SELECT max(id) FROM activity_log), 1))`);
  } else { log("dry", "would copy activity_log"); }

  // ── Step 11: migrate credentials ──
  step(11, "Migrate credentials from .env");
  if (!opts.dryRun) {
    const tenantKey = deriveTenantKey(env.ENCRYPTION_SECRET, tenantId);
    for (const c of ENV_CREDENTIALS) {
      const v = env[c.envName];
      if (!v) { log("warn", `${c.envName} not in .env — skipping`); continue; }
      let plaintext;
      try {
        plaintext = c.isPlatformEncrypted
          ? decryptPlatformCredential(v, env.ENCRYPTION_SECRET, env.ENCRYPTION_SALT)
          : v;
      } catch (e) { log("err", `decrypt ${c.envName}: ${e.message}`); continue; }
      const blob = encryptTenantCredential(plaintext, tenantKey);
      await client.query(
        `INSERT INTO credentials (tenant_id, key, value_enc) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
        [tenantId, c.credKey, blob]
      );
      log("ok", `stored ${c.credKey}`);
    }
  } else { log("dry", "would migrate credentials"); }

  // ── Cleanup ──
  if (sqlite) sqlite.close();
  if (client) await client.end();

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Migration complete${opts.dryRun ? " [DRY-RUN]" : ""}`);
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
