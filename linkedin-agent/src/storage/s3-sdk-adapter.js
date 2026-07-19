// ═══════════════════════════════════════════════════════════════
// src/storage/s3-sdk-adapter.js - the ONE @aws-sdk import site
// ═══════════════════════════════════════════════════════════════
// The adapter side of the ruled port: translates the application's
// object-store contract into AWS SDK v3 commands and normalizes SDK
// exceptions into the port's typed errors, so no SDK type or error
// shape ever escapes into application code. Enforced by the design
// suite: this file is the ONLY module in src/ that may reference
// @aws-sdk, and only via lazy import, so the application boots and
// runs on the db backend without the package installed.
//
// Operator install step (package.json never ships in zips):
//   npm install @aws-sdk/client-s3@3.1090.0 --save-exact
//
// Compatibility notes, deliberate:
//   - requestChecksumCalculation / responseChecksumValidation are
//     pinned to WHEN_REQUIRED so S3-compatible vendors (R2, MinIO,
//     B2) are not broken by the SDK's newer checksum defaults.
//   - forcePathStyle accompanies a custom endpoint, since MinIO and
//     several compatibles do not serve virtual-host style buckets.
//   - Credentials ride the SDK default chain: the EC2 instance role
//     in production, standard AWS_* variables elsewhere. No keys are
//     handled by this module and none belong in application config.
// ═══════════════════════════════════════════════════════════════

import { objectStoreError, isObjectStoreError, OBJECT_STORE_ERROR_CODES } from "./object-store.js";

function stripQuotes(etag) {
  if (typeof etag !== "string") return null;
  return etag.replace(/^"+|"+$/g, "") || null;
}

// Map an SDK exception to a typed port error. Message text is our
// own; SDK details are reduced to name and status, never echoed raw.
function normalize(err, op, key) {
  const name = err && err.name ? String(err.name) : "";
  const status = err && err.$metadata && err.$metadata.httpStatusCode ? err.$metadata.httpStatusCode : null;
  if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
    return objectStoreError(OBJECT_STORE_ERROR_CODES.OBJECT_NOT_FOUND,
      `Object not found (${op})`, { op, key, status });
  }
  if (name === "AccessDenied" || status === 403) {
    return objectStoreError(OBJECT_STORE_ERROR_CODES.ACCESS_DENIED,
      `Object storage access denied (${op})`, { op, key, status });
  }
  return objectStoreError(OBJECT_STORE_ERROR_CODES.STORE_FAILED,
    `Object storage request failed (${op})`, { op, key, status, name });
}

async function defaultLoadSdk() {
  try {
    return await import("@aws-sdk/client-s3");
  } catch (err) {
    throw objectStoreError(OBJECT_STORE_ERROR_CODES.SDK_UNAVAILABLE,
      "@aws-sdk/client-s3 is not installed; run the operator install step before enabling the s3 backend",
      { cause: err && err.message });
  }
}

// Build the adapter. config: { bucket, region, endpoint|null }, all
// validated by the port before this is called; asserted again here as
// defense in depth. deps.loadSdk is injectable so the translation
// logic is testable without the package.
export async function createS3ObjectStore(config, deps = {}) {
  if (!config || typeof config.bucket !== "string" || config.bucket === "" ||
      typeof config.region !== "string" || config.region === "") {
    throw objectStoreError(OBJECT_STORE_ERROR_CODES.NOT_CONFIGURED,
      "Object storage requires a bucket and region");
  }
  // The boundary guarantee: a loader failure surfaces as a typed
  // SDK_UNAVAILABLE no matter WHICH loader failed. defaultLoadSdk
  // wraps its own import miss, but an injected loader's throw would
  // otherwise escape untyped across the port boundary.
  let sdk;
  try {
    sdk = await (deps.loadSdk || defaultLoadSdk)();
  } catch (err) {
    if (isObjectStoreError(err)) throw err;
    throw objectStoreError(OBJECT_STORE_ERROR_CODES.SDK_UNAVAILABLE,
      "the SDK loader failed; the s3 backend is unavailable", { cause: err && err.message });
  }
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = sdk;

  const clientConfig = {
    region: config.region,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  };
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
    clientConfig.forcePathStyle = true;
  }
  const client = new S3Client(clientConfig);

  async function put({ key, body, contentType }) {
    try {
      const res = await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: body, ContentType: contentType || "application/octet-stream"
      }));
      return { bucket: config.bucket, region: config.region, etag: stripQuotes(res && res.ETag) };
    } catch (err) { throw normalize(err, "put", key); }
  }

  async function get({ bucket, key }) {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket || config.bucket, Key: key }));
      const bytes = res && res.Body && typeof res.Body.transformToByteArray === "function"
        ? Buffer.from(await res.Body.transformToByteArray())
        : Buffer.from([]);
      return { body: bytes, contentType: (res && res.ContentType) || null };
    } catch (err) { throw normalize(err, "get", key); }
  }

  async function head({ bucket, key }) {
    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket || config.bucket, Key: key }));
      return { exists: true, byteSize: res && Number.isFinite(res.ContentLength) ? res.ContentLength : null, contentType: (res && res.ContentType) || null };
    } catch (err) {
      const n = normalize(err, "head", key);
      if (n.code === OBJECT_STORE_ERROR_CODES.OBJECT_NOT_FOUND) return { exists: false, byteSize: null, contentType: null };
      throw n;
    }
  }

  async function remove({ bucket, key }) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket || config.bucket, Key: key }));
      return { removed: true };                    // S3 delete is idempotent by design
    } catch (err) {
      const n = normalize(err, "remove", key);
      if (n.code === OBJECT_STORE_ERROR_CODES.OBJECT_NOT_FOUND) return { removed: true };
      throw n;
    }
  }

  return Object.freeze({ put, get, head, remove });
}
