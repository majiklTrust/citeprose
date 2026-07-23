// ═══════════════════════════════════════════════════════════════
// src/storage/object-store.js - the object storage PORT (Phase 4)
// ═══════════════════════════════════════════════════════════════
// The application-facing boundary for object storage, per the ruled
// architecture: the application codes against THIS contract and never
// against SDK types. The one SDK adapter (s3-sdk-adapter.js) is the
// only module allowed to import @aws-sdk/*, a rule the design suite
// enforces. This module itself imports nothing vendor-shaped.
//
// Contract (conforms to the shipped image-store expectation):
//   put({ key, body, contentType }) -> { bucket, region, etag }
//   get({ bucket, key })            -> { body, contentType }
//   head({ bucket, key })           -> { exists, byteSize, contentType }
//   remove({ bucket, key })         -> { removed }
//
// resolveObjectStore() is the fail-closed configuration gate:
//   - unconfigured (no IMAGE_S3_BUCKET + IMAGE_S3_REGION) -> null,
//     WITHOUT ever loading the SDK, so db-backend servers never pay
//     for the dependency at runtime.
//   - configured -> the lazily built adapter (loads the SDK on first
//     resolution; a missing package surfaces as a typed
//     SDK_UNAVAILABLE, never a crash).
//   - a poisoned custom endpoint (non-https, non-loopback) is refused
//     BEFORE any client is constructed. The SDK runs its own HTTP
//     stack outside the shared egress kernel, so this boundary check
//     is where the egress property is restored.
// ═══════════════════════════════════════════════════════════════

export const OBJECT_STORE_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  SDK_UNAVAILABLE: "SDK_UNAVAILABLE",
  ENDPOINT_BLOCKED: "ENDPOINT_BLOCKED",
  OBJECT_NOT_FOUND: "OBJECT_NOT_FOUND",
  ACCESS_DENIED: "ACCESS_DENIED",
  STORE_FAILED: "STORE_FAILED"
});
const KNOWN = new Set(Object.values(OBJECT_STORE_ERROR_CODES));

export class ObjectStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = KNOWN.has(code) ? code : OBJECT_STORE_ERROR_CODES.STORE_FAILED;
    if (details) this.details = details;
  }
}
export function objectStoreError(code, message, details) {
  return new ObjectStoreError(code, message, details);
}
export function isObjectStoreError(err) {
  return err instanceof ObjectStoreError;
}

// Read the storage configuration from the environment. Configured
// means bucket AND region are present; endpoint is optional and only
// for S3-compatible vendors (R2, MinIO, B2). Values never in zips.
export function readObjectStoreConfig(env = process.env) {
  const bucket = typeof env.IMAGE_S3_BUCKET === "string" ? env.IMAGE_S3_BUCKET.trim() : "";
  const region = typeof env.IMAGE_S3_REGION === "string" ? env.IMAGE_S3_REGION.trim() : "";
  const endpoint = typeof env.IMAGE_S3_ENDPOINT === "string" && env.IMAGE_S3_ENDPOINT.trim() !== ""
    ? env.IMAGE_S3_ENDPOINT.trim() : null;
  if (!bucket || !region) return null;
  return Object.freeze({ bucket, region, endpoint });
}

// A custom endpoint must be https, or http only to loopback (local
// MinIO), mirroring the image registry's base-url poison rule. Fail
// closed on anything else: this is the egress boundary for a client
// whose network stack the shared kernel cannot wrap.
export function validateEndpoint(endpoint) {
  if (endpoint === null || endpoint === undefined) return null;
  let u;
  try { u = new URL(endpoint); } catch {
    throw objectStoreError(OBJECT_STORE_ERROR_CODES.ENDPOINT_BLOCKED,
      "IMAGE_S3_ENDPOINT is not a valid URL", { endpoint });
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.toString();
  throw objectStoreError(OBJECT_STORE_ERROR_CODES.ENDPOINT_BLOCKED,
    "IMAGE_S3_ENDPOINT must be https, or http to loopback only", { endpoint });
}

// Single cached instance: env does not change at runtime, and the
// adapter holds an SDK client worth reusing. Reset hook for tests.
let cached = null;
let cachedKey = null;
export function resetObjectStoreCache() { cached = null; cachedKey = null; }

export async function resolveObjectStore(env = process.env, deps = {}) {
  const config = readObjectStoreConfig(env);
  if (!config) return null;                       // fail-closed: unconfigured means unavailable
  const endpoint = validateEndpoint(config.endpoint); // throws ENDPOINT_BLOCKED before any SDK load
  const key = `${config.bucket}|${config.region}|${endpoint || ""}`;
  if (cached && cachedKey === key) return cached;
  const create = deps.createAdapter ||
    (async (cfg) => (await import("./s3-sdk-adapter.js")).createS3ObjectStore(cfg));
  cached = await create(Object.freeze({ bucket: config.bucket, region: config.region, endpoint }));
  cachedKey = key;
  return cached;
}
