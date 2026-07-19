// ═══════════════════════════════════════════════════════════════
// src/services/image-store.js - the image storage port
// ═══════════════════════════════════════════════════════════════
// One port over two interchangeable backends, selected per image.
// The master row in `images` records which backend holds the bytes;
// switching a tenant's default changes only NEW images, and reads
// always follow the backend recorded on the row.
//
//   db  (default) : bytes live in image_bytes (bytea). Fully wired.
//   s3            : object lives in an S3 bucket; image_s3 records
//                   the location (never credentials). The actual
//                   PUT/GET goes through the object-store PORT (an
//                   injected client wins; else the configured
//                   src/storage adapter resolves lazily), so
//                   this module adds NO new npm dependency. With no
//                   client wired the s3 path is fail-closed
//                   (STORAGE_BACKEND_UNAVAILABLE); full S3 wiring is
//                   a later phase.
//
// All DB access uses the ambient tenant client (currentClient), so
// every write and read is inside the request transaction and RLS
// scopes it to the tenant. Callers run inside withTenant.
//
// Errors are typed via StoreError, each carrying a .code so the
// route maps them uniformly alongside the seam's ImageError codes.
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
// DB modules are imported lazily inside the ambient-client resolver
// and the backend-default read, so this module loads without a
// database and unit tests inject a fake client through deps.client.

export const STORE_ERROR_CODES = Object.freeze({
  STORAGE_BACKEND_UNAVAILABLE: "STORAGE_BACKEND_UNAVAILABLE",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  STORAGE_FAILED: "STORAGE_FAILED",
  INVALID_INPUT: "INVALID_INPUT",
  NO_TENANT_CONTEXT: "NO_TENANT_CONTEXT"
});
const KNOWN = new Set(Object.values(STORE_ERROR_CODES));

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StoreError";
    this.code = KNOWN.has(code) ? code : STORE_ERROR_CODES.STORAGE_FAILED;
    this.details = details && typeof details === "object" ? details : {};
  }
}
function storeError(code, message, details) { return new StoreError(code, message, details); }

const VALID_BACKENDS = new Set(["db", "s3"]);

async function ambientClient(deps) {
  let c = deps && deps.client;
  if (!c) {
    const resolve = (deps && deps.currentClient) || (async () => {
      const { currentClient } = await import("../db/with-tenant.js");
      return currentClient();
    });
    c = await resolve();
  }
  if (!c) throw storeError(STORE_ERROR_CODES.NO_TENANT_CONTEXT, "Image storage requires tenant context (call inside withTenant)");
  return c;
}

// Backend resolution: explicit override wins if valid; otherwise the
// tenant default (agent_state.image_storage_backend); otherwise db.
// Fail-closed to db, the fully wired backend.
export async function resolveStorageBackend(override, deps = {}) {
  if (typeof override === "string" && VALID_BACKENDS.has(override)) return override;
  const read = deps.getStorageBackend || (async () => {
    const { getAgentState } = await import("./database.js");
    return getAgentState("image_storage_backend");
  });
  const val = await read();
  return val === "s3" ? "s3" : "db";
}

function decodeBase64(b64) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw storeError(STORE_ERROR_CODES.INVALID_INPUT, "Image payload is missing base64 content");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) {
    throw storeError(STORE_ERROR_CODES.INVALID_INPUT, "Image payload did not decode to any bytes");
  }
  return buf;
}

async function resolveS3Client(deps) {
  // Injection wins (tests, alternative clients). Otherwise resolve
  // the configured object-store PORT lazily: unconfigured servers
  // return null there and this stays the same typed, fail-closed
  // refusal it has been since 2.5.2. The SDK loads only on a
  // configured server the first time an s3-backed image moves.
  const injected = deps && deps.s3Client;
  if (injected && typeof injected.put === "function" && typeof injected.get === "function") {
    return injected;
  }
  try {
    const { resolveObjectStore } = await import("../storage/object-store.js");
    const resolved = await resolveObjectStore();
    if (resolved) return resolved;
  } catch (err) {
    throw storeError(STORE_ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "S3 storage backend is selected but unavailable: " + err.message, { code: err.code });
  }
  throw storeError(STORE_ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
    "S3 storage backend is selected but not configured; set IMAGE_S3_BUCKET and IMAGE_S3_REGION or set the tenant backend to db");
}

// Persist one rendered image: the master row, then the backend
// detail, then mark it stored. All in the ambient transaction, so a
// failure (for example an unavailable S3 backend) rolls the whole
// thing back with no orphan master row.
export async function storeImage(input, deps = {}) {
  if (!input || typeof input !== "object" || !input.image || typeof input.image !== "object") {
    throw storeError(STORE_ERROR_CODES.INVALID_INPUT, "storeImage requires an image payload");
  }
  if (typeof input.createdBy !== "string" || input.createdBy.length === 0) {
    throw storeError(STORE_ERROR_CODES.INVALID_INPUT, "storeImage requires createdBy (the acting user)");
  }
  // Validate input BEFORE any DB work: bad input fails fast with no round-trip.
  let bytes = decodeBase64(input.image.b64);
  const mime = typeof input.image.mime === "string" ? input.image.mime : "image/png";
  // Strip embedded provenance metadata (C2PA, XMP, EXIF) before the
  // bytes are hashed or stored (2.5.21). Availability wins on a parse
  // failure: a paid render is kept with a loud warning rather than
  // lost, and the warning is observable in the platform log.
  try {
    const { stripImageMetadata } = await import("../image/strip-metadata.js");
    bytes = stripImageMetadata(bytes, mime).bytes;
  } catch (err) {
    const { platformLog } = await import("./platform-log.js");
    platformLog("warn", "image_metadata_strip_failed", { error: err.message, mime });
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  const c = await ambientClient(deps);
  const backend = await resolveStorageBackend(input.storageBackend, deps);

  // 1. master row (tenant_id via current_tenant_id() satisfies RLS WITH CHECK)
  const ins = await c.query(
    `INSERT INTO images
       (tenant_id, source_kind, source_post_id, source_topic_id, human_name, brief,
        lens_id, provider, model, prompt, seed, aspect, width, height, mime, byte_size,
        storage_backend, status, cost_estimate_usd, verified_metric_ref, created_by,
        input_tokens, output_tokens, pre_spend_estimate_usd)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, 'pending', $17, $18, $19, $20, $21, $22)
     RETURNING id`,
    [
      input.sourceKind || "blank", input.sourcePostId ?? null, input.sourceTopicId ?? null,
      input.humanName ?? null, input.brief ?? null, input.lensId ?? null,
      input.provider, input.model, input.prompt, input.seed ?? null, input.aspect ?? null,
      input.image.width ?? null, input.image.height ?? null, mime, bytes.length,
      backend, Number.isFinite(input.costEstimateUsd) ? input.costEstimateUsd : 0,
      input.verifiedMetricRef ?? null, input.createdBy,
      Number.isInteger(input.inputTokens) ? input.inputTokens : null,
      Number.isInteger(input.outputTokens) ? input.outputTokens : null,
      Number.isFinite(input.preSpendEstimateUsd) ? input.preSpendEstimateUsd : null
    ]
  );
  const imageId = ins.rows[0].id;

  // 2. backend detail
  if (backend === "db") {
    await c.query(
      `INSERT INTO image_bytes (image_id, tenant_id, bytes, sha256, encoding)
       VALUES ($1, current_tenant_id(), $2, $3, 'base64')`,
      [imageId, bytes, sha256]
    );
  } else {
    const s3 = await resolveS3Client(deps);
    const objectKey = `tenants/${input.tenantSlug || "t"}/images/${imageId}`;
    const put = await s3.put({ key: objectKey, body: bytes, contentType: mime });
    await c.query(
      `INSERT INTO image_s3 (image_id, tenant_id, bucket, object_key, region, visibility, etag)
       VALUES ($1, current_tenant_id(), $2, $3, $4, 'private', $5)`,
      [imageId, put.bucket, objectKey, put.region ?? null, put.etag ?? null]
    );
  }

  // 3. mark stored
  await c.query("UPDATE images SET status = 'stored', updated_at = now() WHERE id = $1", [imageId]);
  return { id: imageId, storageBackend: backend, mime, byteSize: bytes.length, sha256 };
}

// Read an image's bytes for serving, following the backend recorded
// on the master row. RLS ensures a tenant can only read its own.
export async function readImageBytes(imageId, deps = {}) {
  const c = await ambientClient(deps);
  const meta = await c.query("SELECT storage_backend, mime FROM images WHERE id = $1", [imageId]);
  if (meta.rows.length === 0) {
    throw storeError(STORE_ERROR_CODES.IMAGE_NOT_FOUND, "Image not found in this workspace", { imageId });
  }
  const { storage_backend: backend, mime } = meta.rows[0];
  if (backend === "db") {
    const r = await c.query("SELECT bytes FROM image_bytes WHERE image_id = $1", [imageId]);
    if (r.rows.length === 0) {
      throw storeError(STORE_ERROR_CODES.IMAGE_NOT_FOUND, "Image bytes missing for a db-backed image", { imageId });
    }
    return { bytes: r.rows[0].bytes, mime, backend };
  }
  const s3 = await resolveS3Client(deps);
  const loc = await c.query("SELECT bucket, object_key FROM image_s3 WHERE image_id = $1", [imageId]);
  if (loc.rows.length === 0) {
    throw storeError(STORE_ERROR_CODES.IMAGE_NOT_FOUND, "S3 location missing for an s3-backed image", { imageId });
  }
  const got = await s3.get({ bucket: loc.rows[0].bucket, key: loc.rows[0].object_key });
  return { bytes: got.body, mime, backend };
}

// Master-row metadata for the picker, attach flow, and serve headers.
export async function getImageMeta(imageId, deps = {}) {
  const c = await ambientClient(deps);
  const r = await c.query(
    `SELECT id, source_kind, source_post_id, source_topic_id, human_name, brief, lens_id,
            provider, model, prompt, aspect, width, height, mime, byte_size, storage_backend,
            status, cost_estimate_usd, verified_metric_ref, created_by, created_at,
            input_tokens, output_tokens, pre_spend_estimate_usd
     FROM images WHERE id = $1`,
    [imageId]
  );
  if (r.rows.length === 0) {
    throw storeError(STORE_ERROR_CODES.IMAGE_NOT_FOUND, "Image not found in this workspace", { imageId });
  }
  return r.rows[0];
}

// Delete an image; detail rows cascade. Posts referencing it null
// their generated_image_id (ON DELETE SET NULL from 40.1).
export async function deleteImage(imageId, deps = {}) {
  const c = await ambientClient(deps);
  // Capture the S3 location BEFORE the delete cascades it away, so an
  // s3-backed image can have its object removed too instead of
  // orphaning bucket data. Removal is best-effort AFTER the DB delete
  // commits the intent: a bucket hiccup logs a warning and leaves an
  // orphan to sweep later, but never resurrects the deleted image.
  const loc = await c.query(
    `SELECT s.bucket, s.object_key FROM image_s3 s
     JOIN images i ON i.id = s.image_id AND i.tenant_id = s.tenant_id
     WHERE s.image_id = $1 AND i.storage_backend = 's3'`, [imageId]);
  const r = await c.query("DELETE FROM images WHERE id = $1 RETURNING id", [imageId]);
  const deleted = r.rows.length > 0;
  if (deleted && loc.rows.length > 0) {
    try {
      const s3 = await resolveS3Client(deps);
      if (typeof s3.remove === "function") {
        await s3.remove({ bucket: loc.rows[0].bucket, key: loc.rows[0].object_key });
      }
    } catch (err) {
      const { platformLog } = await import("./platform-log.js");
      platformLog("warn", "image_s3_object_orphaned", { imageId, error: err.message });
    }
  }
  return { deleted, id: deleted ? r.rows[0].id : null };
}

// ── Tenant-shared library (Phase 4) ────────────────────────────
// Metadata-only listing of the tenant's stored images, newest first.
// RLS scopes rows to the ambient tenant; only status = 'stored' rows
// appear (pending and failed rows are pipeline internals, not library
// content). Bytes are never returned here; the serve endpoint streams
// them. Limits are clamped defensively so a hostile limit or offset
// can shape the page but never the load.
const LIBRARY_MAX_LIMIT = 50;
const LIBRARY_DEFAULT_LIMIT = 20;
const LIBRARY_MAX_OFFSET = 100000;

function clampInt(v, min, max, fallback) {
  let n = null;
  if (typeof v === "number" && Number.isInteger(v)) n = v;
  else if (typeof v === "string" && /^\d+$/.test(v.trim())) n = parseInt(v.trim(), 10);
  if (n === null || n < min) return fallback;
  return n > max ? max : n;
}

export async function listImages(opts = {}, deps = {}) {
  const c = await ambientClient(deps);
  const limit = clampInt(opts.limit, 1, LIBRARY_MAX_LIMIT, LIBRARY_DEFAULT_LIMIT);
  const offset = clampInt(opts.offset, 0, LIBRARY_MAX_OFFSET, 0);
  const r = await c.query(
    `SELECT id, source_kind, source_post_id, source_topic_id, human_name, lens_id,
            provider, model, aspect, width, height, mime, byte_size, storage_backend,
            status, cost_estimate_usd, created_by, created_at
     FROM images
     WHERE status = 'stored'
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return r.rows;
}
