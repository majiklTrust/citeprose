// =================================================================
// src/storage/s3-destination.js - the tenant destination grammar
// =================================================================
// Purpose: parse and format the single-line tenant image
// destination string:
//
//   s3://bucket[/prefix]?region=REGION[&endpoint=https://host[:port]]
//
// This module is PURE: no I/O, no SDK, no environment reads. It is
// the grammar boundary in front of the object-store port. The port
// (object-store.js) and the admin route build on the typed result;
// the one SDK adapter stays the only vendor import site.
//
// Security posture (Zero Trust, fail closed):
//   - Every violation throws the same typed refusal code,
//     DESTINATION_ERROR_CODE, so callers can map it to HTTP 400
//     without inspecting message text.
//   - credentials are not accepted in the destination string, in
//     any position: access uses the server's ambient identity.
//   - The bucket must be a strict lowercase DNS-safe S3 name; the
//     prefix refuses traversal segments and anything outside the
//     S3 safe set; region is required; the optional endpoint must
//     be https, or http to loopback only, with no userinfo, path,
//     query, or fragment.
//   - Refusal messages NEVER echo the raw input, parameter values,
//     or credentials; they describe the rule that was violated.
// =================================================================

// The one typed refusal code for every grammar violation. The admin
// route maps this exact value to HTTP 400 ("fix the string").
export const DESTINATION_ERROR_CODE = "DESTINATION_INVALID";

// Upper bound on the whole destination string. Generous for any
// real bucket + prefix + endpoint, small enough to bound parsing.
const MAX_DESTINATION_CHARS = 2048;

// Upper bound on the normalized prefix. S3 caps object keys at
// 1024 bytes; this leaves room for the object names appended later.
const MAX_PREFIX_CHARS = 512;

// Strict S3 bucket naming: 3-63 chars, lowercase letters, digits,
// dots, and hyphens, starting and ending alphanumeric. Checked
// together with the no-dot-runs and not-an-IP rules below.
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const BUCKET_IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// One prefix segment: the S3 safe set (letters, digits, and
// ! - _ . * ' ( ) ), per the AWS object key naming guidance.
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9!_.*'()-]+$/;

// Region grammar: lowercase letter first, then lowercase letters,
// digits, and hyphens (covers all AWS regions and vendor "auto").
const REGION_RE = /^[a-z][a-z0-9-]{1,31}$/;

// Anything outside printable ASCII (0x21 to 0x7e) anywhere in the
// string, spaces and control characters included, is refused
// outright before any structural parsing.
const FORBIDDEN_CHARS_RE = /[^!-~]/;

// The scheme every destination must carry, lowercase, exactly.
const SCHEME = "s3://";

// The only query parameters the grammar accepts.
const KNOWN_PARAMS = Object.freeze(["region", "endpoint"]);

// Loopback hostnames for which a plain http endpoint is tolerated
// (local MinIO in development). Everything else must be https.
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]", "::1"]);

class S3DestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = "S3DestinationError";
    this.code = DESTINATION_ERROR_CODE;
  }
}

function refuse(message) {
  throw new S3DestinationError(message);
}

// ---- component validators (each refuses, never repairs) ---------

function validateBucket(bucket) {
  if (bucket === "") {
    refuse("the destination names no bucket (expected s3://bucket[/prefix]?region=...)");
  }
  if (bucket.includes("@")) {
    // Checked before shape so an access key never reads as a "bad
    // bucket name". credentials are not accepted in the destination
    // in any position; access uses the server's ambient identity.
    refuse("credentials are not accepted in the destination; remove the user:secret@ part");
  }
  if (bucket.includes(":")) {
    refuse("a port or colon is not accepted in the bucket authority");
  }
  if (!BUCKET_RE.test(bucket) || bucket.includes("..") || BUCKET_IPV4_RE.test(bucket)) {
    refuse("the bucket name must be 3-63 lowercase letters, digits, dots, or hyphens, starting and ending alphanumeric, and not an IP address");
  }
  return bucket;
}

// Normalizes a valid path into the stored prefix form: "" for no
// prefix, otherwise "seg/seg/" with exactly one trailing slash.
function validatePrefix(path) {
  if (path === "" || path === "/") return "";
  let body = path;
  if (body.endsWith("/")) body = body.slice(0, -1); // tolerate one trailing slash
  if (body.length > MAX_PREFIX_CHARS) {
    refuse("the destination prefix exceeds the maximum length");
  }
  const segments = body.split("/");
  for (const segment of segments) {
    if (segment === "") {
      refuse("the destination prefix contains an empty segment (double slash)");
    }
    if (segment === "." || segment === "..") {
      refuse("the destination prefix contains traversal segments (. or ..), which are refused");
    }
    if (!PREFIX_SEGMENT_RE.test(segment)) {
      refuse("the destination prefix contains characters outside the S3 safe set (letters, digits, ! - _ . * ' ( ) per segment)");
    }
  }
  return segments.join("/") + "/";
}

function validateRegion(region) {
  if (region === null || region === "") {
    refuse("region is required (append ?region=... to the destination)");
  }
  if (!REGION_RE.test(region)) {
    refuse("the region must be lowercase letters, digits, and hyphens");
  }
  return region;
}

// The optional endpoint (S3-compatible vendors: R2, MinIO, B2).
// Returned as the raw accepted string, never rewritten, so what the
// operator typed is what the adapter and the admin card see.
function validateDestinationEndpoint(endpoint) {
  if (endpoint === null) return null;
  if (endpoint === "") {
    refuse("the endpoint parameter is present but empty");
  }
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    refuse("the endpoint is not a valid URL");
  }
  if (u.username !== "" || u.password !== "") {
    // Second credential gate: credentials are not accepted in the
    // destination endpoint either; only ambient identity reaches S3.
    refuse("credentials are not accepted in the destination endpoint");
  }
  const loopback = LOOPBACK_HOSTS.indexOf(u.hostname) !== -1;
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) {
    refuse("the endpoint must be https, or http to loopback only");
  }
  if ((u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "") {
    refuse("the endpoint must not carry a path, query, or fragment");
  }
  return endpoint;
}

// ---- query parsing (strict key=value, known keys only) ----------

function parseQuery(query) {
  const seen = Object.create(null);
  if (query === null) return seen;
  if (query === "") {
    refuse("the destination query is empty (expected ?region=...)");
  }
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      refuse("a destination parameter is malformed (expected key=value)");
    }
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (KNOWN_PARAMS.indexOf(key) === -1) {
      refuse("only region and endpoint parameters are accepted");
    }
    if (key in seen) {
      refuse("a destination parameter is repeated");
    }
    seen[key] = value;
  }
  return seen;
}

// ---- the public grammar ----------------------------------------

// Parse a destination string into the frozen truth:
//   { bucket, prefix, region, endpoint }
// prefix is "" or "seg/seg/" (one trailing slash); endpoint is the
// raw accepted URL string or null. Throws S3DestinationError with
// code DESTINATION_ERROR_CODE on ANY violation: this parser fails
// closed and never repairs hostile input into something usable.
export function parseS3Destination(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    refuse("a destination is required (s3://bucket[/prefix]?region=...)");
  }
  const s = raw.trim();
  if (s.length > MAX_DESTINATION_CHARS) {
    refuse("the destination exceeds the maximum length");
  }
  if (FORBIDDEN_CHARS_RE.test(s)) {
    refuse("the destination contains whitespace or control characters");
  }
  if (!s.startsWith(SCHEME)) {
    refuse("the destination must use the s3:// scheme");
  }
  const rest = s.slice(SCHEME.length);
  const q = rest.indexOf("?");
  const locator = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? null : rest.slice(q + 1);
  const slash = locator.indexOf("/");
  const bucket = validateBucket(slash === -1 ? locator : locator.slice(0, slash));
  const prefix = validatePrefix(slash === -1 ? "" : locator.slice(slash + 1));
  const params = parseQuery(query);
  const region = validateRegion("region" in params ? params.region : null);
  const endpoint = validateDestinationEndpoint("endpoint" in params ? params.endpoint : null);
  return Object.freeze({ bucket, prefix, region, endpoint });
}

// Format a parsed destination back into its canonical single-line
// string. Zero Trust on the way out too: the built string is run
// back through parseS3Destination, so a tampered or hand-built
// object can never format into a string this module would refuse.
export function formatS3Destination(dest) {
  if (!dest || typeof dest !== "object") {
    refuse("formatS3Destination requires a parsed destination object");
  }
  const prefix = typeof dest.prefix === "string" && dest.prefix !== ""
    ? "/" + dest.prefix.replace(/\/+$/, "")   // display form drops the stored trailing slash
    : "";
  const endpoint = typeof dest.endpoint === "string" && dest.endpoint !== ""
    ? "&endpoint=" + dest.endpoint
    : "";
  const s = SCHEME + String(dest.bucket) + prefix + "?region=" + String(dest.region) + endpoint;
  parseS3Destination(s);                       // throws typed if the object was not parser-true
  return s;
}
