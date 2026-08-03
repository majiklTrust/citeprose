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
//
// Tenant destination layer (Phase 6). Purpose: a tenant-scoped
// destination string (grammar in s3-destination.js) precedes the
// platform env in resolveObjectStore, and a destination is only
// ever persisted after probeObjectStoreDestination proves it live
// (write, read back, compare, delete). Security posture: fail
// closed on every parse and probe failure with typed errors, no
// credentials in destination strings (the parser refuses them, the
// ambient identity is used), and no secret material is ever placed
// in messages, keys, or probe payloads.
// ═══════════════════════════════════════════════════════════════

import { randomBytes } from "node:crypto";
import { parseS3Destination } from "./s3-destination.js";

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
// adapter holds an SDK client worth reusing. Destination-backed
// stores live in their own cache keyed by the destination string,
// since destinations are tenant state, not process state. The one
// reset hook clears BOTH caches so tests and the admin save path
// can never serve a stale store.
let cached = null;
let cachedKey = null;
const destCache = new Map();
export function resetObjectStoreCache() { cached = null; cachedKey = null; destCache.clear(); }

// ── The tenant destination layer ─────────────────────────────

// The agent_state key under which the admin route persists the
// tenant destination string (GET/PUT /image-destination).
export const DESTINATION_STATE_KEY = "image_destination";

// Transient probe object naming and payload sizing. The name leads
// with a dot so bucket listings read it as a marker; every probe
// uses a fresh random name and a fresh random payload (no secret
// material, nothing guessable, nothing worth logging).
const VERIFY_KEY_PREFIX = ".verify-";
const VERIFY_PAYLOAD_BYTES = 32;
const VERIFY_CONTENT_TYPE = "application/octet-stream";

// Read the tenant destination through the injected reader. Callers
// that carry tenant context (routes, services running inside
// withTenant) inject deps.readDestination; without a reader there
// is no tenant destination and the platform env applies. A reader
// that returns a blank reads as "not set", never as an error.
async function readTenantDestination(deps) {
  if (!deps || typeof deps.readDestination !== "function") return null;
  const raw = await deps.readDestination();
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

// The adapter factory for destination-backed stores. Injection wins
// (tests, alternative clients); the default lazily loads the one
// SDK adapter and narrows it to the destination verb contract:
//   put(key, bytes, opts) / get(key) -> { bytes } / head(key) /
//   remove(key). Keys are full object keys; prefixing happens in
// the wrapper so the adapter stays prefix-blind.
function destinationAdapter(deps) {
  if (deps && typeof deps.createAdapter === "function") return deps.createAdapter;
  return async (cfg) => {
    const inner = await (await import("./s3-sdk-adapter.js")).createS3ObjectStore(cfg);
    return Object.freeze({
      put: (key, bytes, opts) => inner.put({ key, body: bytes, contentType: opts && opts.contentType }),
      get: async (key) => {
        const res = await inner.get({ key });
        return { bytes: res.body, contentType: res.contentType };
      },
      head: (key) => inner.head({ key }),
      remove: (key) => inner.remove({ key })
    });
  };
}

// Fold any non-port error into the typed contract. Known codes on
// the original error (for example ACCESS_DENIED from an adapter)
// survive; anything else becomes STORE_FAILED. Message text is our
// own; the original message travels only in details, truncated.
function asObjectStoreError(err, message) {
  if (isObjectStoreError(err)) return err;
  const code = err && typeof err.code === "string" ? err.code : OBJECT_STORE_ERROR_CODES.STORE_FAILED;
  return objectStoreError(code, message, {
    name: (err && err.name) || null,
    status: (err && err.status) || null,
    cause: err && err.message ? String(err.message).slice(0, 200) : null
  });
}

// Build (or reuse) the store for a parsed tenant destination: the
// adapter is created for the exact bucket, region, and endpoint the
// grammar produced, and the returned wrapper applies the parsed key
// prefix to all four verbs. A destination that fails to parse
// throws the typed DESTINATION_INVALID and nothing is constructed.
async function resolveDestinationStore(destination, deps) {
  const parsed = parseS3Destination(destination); // fail closed BEFORE any adapter work
  if (destCache.has(destination)) return destCache.get(destination);
  const store = await destinationAdapter(deps)(
    Object.freeze({ bucket: parsed.bucket, region: parsed.region, endpoint: parsed.endpoint })
  );
  const prefix = parsed.prefix;
  const wrapped = Object.freeze({
    put: (key, bytes, opts) => store.put(prefix + key, bytes, opts),
    get: (key) => store.get(prefix + key),
    head: (key) => store.head(prefix + key),
    remove: (key) => store.remove(prefix + key)
  });
  destCache.set(destination, wrapped);
  return wrapped;
}

// The four-step live probe behind the admin save path: parse, then
// write a transient object, read it back, compare the bytes, and
// delete it. The delete runs even when an earlier step failed, so
// a refused destination never strands the verification object. On
// success the parsed truth is returned for the route to echo; on
// ANY failure a typed ObjectStoreError (or the parser's typed
// DESTINATION_INVALID) is thrown and nothing should be persisted.
export async function probeObjectStoreDestination(raw, deps = {}) {
  const parsed = parseS3Destination(raw);         // typed refusal; no I/O on bad grammar
  let store;
  try {
    store = await destinationAdapter(deps)(
      Object.freeze({ bucket: parsed.bucket, region: parsed.region, endpoint: parsed.endpoint })
    );
  } catch (err) {
    throw asObjectStoreError(err, "the destination adapter could not be constructed");
  }
  const key = parsed.prefix + VERIFY_KEY_PREFIX + Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
  const payload = randomBytes(VERIFY_PAYLOAD_BYTES);
  let failure = null;
  try {
    await store.put(key, payload, { contentType: VERIFY_CONTENT_TYPE });
    const back = await store.get(key);
    const bytes = back && back.bytes;
    if (!Buffer.isBuffer(bytes) || bytes.length !== payload.length || !bytes.equals(payload)) {
      failure = objectStoreError(OBJECT_STORE_ERROR_CODES.STORE_FAILED,
        "the destination returned different bytes than were written (read-back compare failed)");
    }
  } catch (err) {
    failure = asObjectStoreError(err, "the destination failed the live write/read-back probe");
  }
  try {
    await store.remove(key);                      // cleanup happens on success AND on failure
  } catch (err) {
    if (!failure) failure = asObjectStoreError(err, "the destination failed to delete the verification object");
  }
  if (failure) throw failure;
  return parsed;
}

export async function resolveObjectStore(env = process.env, deps = {}) {
  // Precedence: the tenant destination is consulted FIRST; only
  // when no destination is set does the platform env apply.
  const destination = await readTenantDestination(deps);
  if (destination !== null) return resolveDestinationStore(destination, deps);
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
