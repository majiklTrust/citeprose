// ═══════════════════════════════════════════════════════════════
// src/services/linkedin-publisher.js
// LinkedIn Post Publisher — REST API with image support
// ═══════════════════════════════════════════════════════════════
//
// Unified publisher for LinkedIn posts with optional images.
// Uses the Community Management API (/rest/posts + /rest/images)
// which supports both personal profile and organization page
// publishing through the same endpoints.
//
// Mode selection via .env:
//   LINKEDIN_PUBLISH_MODE=image-posting  — /rest/posts (supports images)
//   LINKEDIN_PUBLISH_MODE=text-posting   — /v2/ugcPosts (text-only, default)
//
// Image upload flow:
//   1. Download image from URL (with SSRF guard + size cap)
//   2. POST /rest/images?action=initializeUpload → uploadUrl + imageUrn
//   3. PUT binary to uploadUrl
//   4. Poll GET /rest/images/{imageUrn} until status = AVAILABLE
//   5. POST /rest/posts with content.media referencing the imageUrn
//
// Must be called inside a withTenant() block — reads credentials
// and writes activity logs via tenant-scoped database calls.
//
// Zero Trust:
//   • SSRF guard on image download (isSafeUrl)
//   • Content-Type + magic byte validation on downloaded images
//   • Download size cap (LINKEDIN_IMAGE_MAX_BYTES, default 10 MB)
//   • LinkedIn-Version header required by REST API (configurable)
//   • Generic error responses — no LinkedIn token details leaked
//   • All credential reads via encrypted credential store
// ═══════════════════════════════════════════════════════════════

import axios from "axios";
import { logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { publishPost as legacyPublishPost } from "./linkedin-api.js";
import { getPublishTarget, isValidPublishTarget } from "./publish-target.js";
import { buildRestPostBody } from "./linkedin-post-request.js";
import {
  getLinkedInAccessToken,
  getLinkedInPersonUrn,
  getLinkedInOrgUrn
} from "../tenant/credential-store.js";
import { isSafeUrl } from "./security.js";
import { currentTenantId } from "../db/with-tenant.js";
import { yieldDb } from "../db/tenant-workflow.js";

// ── Constants ────────────────────────────────────────────────

const LINKEDIN_REST = "https://api.linkedin.com/rest";

// ── Configuration ────────────────────────────────────────────
// All env-driven with safe defaults. Validated at read time.

function getPublishMode() {
  const mode = (process.env.LINKEDIN_PUBLISH_MODE || "text-posting").toLowerCase();
  // Backward compat: "rest" → "image-posting", "legacy" → "text-posting"
  if (mode === "image-posting" || mode === "rest") return "image-posting";
  return "text-posting";
}

// Publish target resolution moved to services/publish-target.js
// (pure core + per-tenant agent_state layer). This module only
// consumes the resolved value; it no longer reads the env var.

function getLinkedInVersion() {
  // LinkedIn REST API date-based version. Must match your approved
  // product version. Check your app's Products tab at
  // developer.linkedin.com for the current version.
  // LinkedIn sunsets versions after ~12 months — update via .env
  // without a code deployment when your product version changes.
  return process.env.LINKEDIN_VERSION || "202509";
}

function getImageMaxBytes() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_MAX_BYTES, 10);
  return val > 0 ? val : 10 * 1024 * 1024; // 10 MB default
}

function getImagePollMaxAttempts() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_POLL_MAX, 10);
  return val > 0 ? val : 10;
}

function getImagePollIntervalMs() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS, 10);
  return val > 0 ? val : 2000; // 2 seconds
}

// ── REST API Headers ─────────────────────────────────────────

function restHeaders(token, contentType = "application/json") {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "LinkedIn-Version": getLinkedInVersion(),
    "X-Restli-Protocol-Version": "2.0.0"
  };
}

// ── EXIF Metadata Stripping ──────────────────────────────────
// Strips EXIF, ICC profiles, and other APP markers from JPEG
// images before uploading to LinkedIn. Prevents leaking GPS
// coordinates, device info, timestamps, and software versions
// from the original photographer.
//
// JPEG structure: a sequence of markers (FF XX). Metadata lives
// in APP1 (EXIF), APP2 (ICC), and APP3-APP15. We remove all
// APPn markers except APP0 (JFIF) which is required.
//
// Non-JPEG formats (PNG, GIF, WebP) pass through unchanged —
// their metadata risk is lower and stripping requires format-
// specific parsers. Flagged for future enhancement.

function stripExifFromJpeg(buffer) {
  // Verify JPEG SOI marker
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return buffer;

  const out = [Buffer.from([0xFF, 0xD8])]; // SOI
  let pos = 2;

  while (pos < buffer.length - 1) {
    // Find next marker
    if (buffer[pos] !== 0xFF) {
      // Not a marker — we've hit compressed data, copy rest
      out.push(buffer.subarray(pos));
      break;
    }

    const marker = buffer[pos + 1];

    // SOS (FF DA) — start of scan. Everything after is
    // compressed image data until EOI. Copy the rest verbatim.
    if (marker === 0xDA) {
      out.push(buffer.subarray(pos));
      break;
    }

    // Markers without length (RST0-RST7, SOI, EOI, TEM)
    if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) {
      out.push(buffer.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }

    // Read segment length (big-endian, includes the 2 length bytes)
    const segLen = buffer.readUInt16BE(pos + 2);
    const segEnd = pos + 2 + segLen;

    // APP1-APP15 (FF E1-FF EF): metadata — SKIP
    if (marker >= 0xE1 && marker <= 0xEF) {
      pos = segEnd;
      continue;
    }

    // APP0 (FF E0 — JFIF) and everything else: KEEP
    out.push(buffer.subarray(pos, segEnd));
    pos = segEnd;
  }

  return Buffer.concat(out);
}

function stripMetadata(buffer, contentType) {
  if (contentType === "image/jpeg") {
    const stripped = stripExifFromJpeg(buffer);
    const removed = buffer.length - stripped.length;
    if (removed > 0) {
      platformLog("info", "exif_stripped", {
        originalBytes: buffer.length,
        strippedBytes: stripped.length,
        removedBytes: removed
      });
    }
    return stripped;
  }

  // PNG, GIF, WebP: pass through (metadata stripping not yet implemented)
  // Risk is lower — PNG tEXt chunks rarely contain GPS/device data.
  return buffer;
}

// ── Image Download ───────────────────────────────────────────
// Downloads an image from a URL with SSRF protection, size cap,
// and Content-Type validation. Returns { buffer, contentType }
// or throws on failure.

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp"
]);

// JPEG: FF D8 FF, PNG: 89 50 4E 47, GIF: 47 49 46, WEBP: 52 49 46 46
const MAGIC_BYTES = [
  { type: "image/jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { type: "image/png",  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { type: "image/gif",  bytes: [0x47, 0x49, 0x46] },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }
];

function detectImageType(buffer) {
  for (const m of MAGIC_BYTES) {
    if (m.bytes.every((b, i) => buffer[i] === b)) return m.type;
  }
  return null;
}

async function downloadImage(imageUrl) {
  if (!isSafeUrl(imageUrl)) {
    throw new Error("Image URL blocked by SSRF protection");
  }

  const maxBytes = getImageMaxBytes();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "LinkedInAIAgent/1.5 (Image Fetch)",
        "Accept": "image/jpeg, image/png, image/gif, image/webp"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`);
  }

  // Validate Content-Type from response headers
  const rawContentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (rawContentType && !ALLOWED_IMAGE_TYPES.has(rawContentType)) {
    throw new Error(`Invalid image Content-Type: ${rawContentType}`);
  }

  // Stream to buffer with size cap
  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error(`Image exceeds size limit (${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);

  // Validate magic bytes — defense in depth against Content-Type spoofing
  const detectedType = detectImageType(buffer);
  if (!detectedType) {
    throw new Error("Image failed magic-byte validation — not a recognized image format");
  }

  return { buffer, contentType: detectedType };
}

// ── Image Upload to LinkedIn ─────────────────────────────────
// Registers the upload, sends the binary, polls until processed.

async function uploadImageToLinkedIn(token, ownerUrn, imageBuffer, contentType) {
  // Step 1: Initialize upload
  const initResponse = await axios.post(
    `${LINKEDIN_REST}/images?action=initializeUpload`,
    {
      initializeUploadRequest: {
        owner: ownerUrn
      }
    },
    { headers: restHeaders(token) }
  );

  const uploadUrl = initResponse.data?.value?.uploadUrl;
  const imageUrn = initResponse.data?.value?.image;

  if (!uploadUrl || !imageUrn) {
    throw new Error("LinkedIn initializeUpload did not return uploadUrl or image URN");
  }

  platformLog("info", "linkedin_image_upload_initialized", {
    imageUrn,
    hasUploadUrl: !!uploadUrl
  });

  // Step 2: Upload binary
  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType
    },
    maxBodyLength: getImageMaxBytes(),
    maxContentLength: getImageMaxBytes()
  });

  platformLog("info", "linkedin_image_binary_uploaded", {
    imageUrn,
    bytes: imageBuffer.length,
    contentType
  });

  // Step 3: Poll until image is processed
  const maxAttempts = getImagePollMaxAttempts();
  const intervalMs = getImagePollIntervalMs();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const statusResponse = await axios.get(
        `${LINKEDIN_REST}/images/${encodeURIComponent(imageUrn)}`,
        { headers: restHeaders(token) }
      );

      const status = statusResponse.data?.status;
      platformLog("info", "linkedin_image_poll", {
        imageUrn, attempt, status
      });

      if (status === "AVAILABLE") {
        return imageUrn;
      }

      if (status === "PROCESSING_FAILED" || status === "WAITING_UPLOAD") {
        throw new Error(`LinkedIn image processing failed: status=${status}`);
      }
    } catch (pollErr) {
      if (pollErr.response?.status === 404 && attempt < maxAttempts) {
        continue; // Image not yet visible — retry
      }
      if (attempt === maxAttempts) {
        throw new Error(`Image processing timed out after ${maxAttempts} attempts`);
      }
    }
  }

  throw new Error("Image processing did not complete within polling window");
}

// ── REST Publisher ────────────────────────────────────────────
// Publishes via /rest/posts — supports both personal profile
// and organization page via the author URN. Optionally includes
// an image if imageUrl is provided.

async function restPublish(content, hashtags, imageUrl, target, imageBytes = null) {
  let token, authorUrn;

  try {
    token = await getLinkedInAccessToken();
    authorUrn = target === "organization"
      ? await getLinkedInOrgUrn()
      : await getLinkedInPersonUrn();
  } catch {
    const targetLabel = target === "organization" ? "organization page" : "personal profile";
    throw new Error(
      `LinkedIn credentials not configured for ${targetLabel} publishing. ` +
      "Connect via /auth/linkedin"
    );
  }

  // Request shape comes from the SHARED builder (Step 3): the org
  // and advocacy publishers differ only in token and author, never
  // in payload shape.
  const payload = buildRestPostBody({ authorUrn, content, hashtags });
  const commentaryText = payload.commentary || "";

  // Item #1 Phase 3: every database read this publish needs (target,
  // token, author URN) has happened, and the wire-length gate above
  // has already refused an oversize post without touching the
  // network. Surrender the lease HERE, before the image and post
  // calls, so LinkedIn's latency is never spent holding a
  // transaction. No-op under classic withTenant.
  await yieldDb();

  // Upload image if provided. A stored (generated) image arrives as
  // bytes and takes precedence: it has no public URL and must never
  // touch the SSRF-guarded download path. A legacy image_url is
  // fetched exactly as before. Either source converges on the same
  // metadata-strip + upload, so the two paths cannot diverge.
  let imageSource = null;
  if (imageBytes && imageBytes.buffer) {
    imageSource = {
      buffer: imageBytes.buffer,
      contentType: imageBytes.contentType || "image/png"
    };
  } else if (imageUrl) {
    platformLog("info", "linkedin_image_download_start", { imageUrl });
    imageSource = await downloadImage(imageUrl);
  }

  if (imageSource) {
    // Strip EXIF/metadata before uploading to LinkedIn.
    // Prevents leaking GPS, device info from article images.
    const cleanBuffer = stripMetadata(imageSource.buffer, imageSource.contentType);

    platformLog("info", "linkedin_image_prepared", {
      bytes: cleanBuffer.length,
      contentType: imageSource.contentType,
      source: (imageBytes && imageBytes.buffer) ? "stored" : "url"
    });

    const imageUrn = await uploadImageToLinkedIn(
      token, authorUrn, cleanBuffer, imageSource.contentType
    );

    payload.content = {
      media: {
        id: imageUrn
      }
    };

    platformLog("info", "linkedin_image_attached", { imageUrn });
  }

  // Publish
  try {
    const response = await axios.post(
      `${LINKEDIN_REST}/posts`,
      payload,
      { headers: restHeaders(token) }
    );

    const location = response.headers["location"] || "";
    const postId = response.headers["x-restli-id"]
      || decodeURIComponent(location.split("/").pop())
      || null;

    if (!postId) {
      await logActivity("warn", "linkedin_post_no_id", {
        status: response.status,
        mode: "rest"
      });
    }

    await logActivity("info", "linkedin_post_published", {
      postId,
      status: response.status,
      contentLength: commentaryText.length,
      hasImage: !!imageSource,
      mode: "rest",
      target
    });

    platformLog("info", "linkedin_post_published", {
      postId, hasImage: !!imageSource, mode: "rest",
      target
    });

    return { success: true, postId };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    const statusCode = err.response?.status;

    await logActivity("error", "linkedin_post_failed", {
      status: statusCode,
      error: errorDetail,
      hasImage: !!imageSource,
      mode: "rest",
      target
    });

    if (statusCode === 401) {
      throw new Error("LinkedIn access token expired. Reconnect via /auth/linkedin");
    }
    if (statusCode === 422) {
      throw new Error(`LinkedIn rejected the post: ${JSON.stringify(errorDetail)}`);
    }

    throw new Error(`LinkedIn API error (${statusCode}): ${JSON.stringify(errorDetail)}`);
  }
}

// ── Public API ───────────────────────────────────────────────
// Single entry point — delegates based on LINKEDIN_PUBLISH_MODE.
//
// publishPost(content, hashtags, imageUrl?)
//   content:  string — post body text
//   hashtags: string[] — appended to content
//   imageUrl: string|null — URL to download and attach (rest mode only)
//   imageBytes: {buffer, contentType}|null - a stored (generated)
//     image's bytes, attached directly in rest mode. Takes precedence
//     over imageUrl and bypasses the SSRF-guarded URL download.
//
// In text-posting mode, an image (URL or bytes) is ignored with a warning.

export async function publishPost(content, hashtags = [], imageUrl = null, targetOverride = null, imageBytes = null) {
  const mode = getPublishMode();
  const hasImage = !!imageUrl || !!(imageBytes && imageBytes.buffer); // ◄ either source counts
  // Per-post destination seam (MDP-proofing): a post may carry its own
  // publish_target (personal|organization), which overrides the global
  // LINKEDIN_PUBLISH_TARGET default. NULL -> global default (today's
  // behavior, unchanged). NOTE: legacyPublishPost/restPublish still read
  // the global target internally for URN selection; threading `target`
  // into them is the remaining wiring when organization/MDP posting is
  // implemented. For v1 this records the per-post target and keeps the
  // data flow destination-aware end to end.
  const target = isValidPublishTarget(targetOverride)
    ? targetOverride
    : await getPublishTarget();
  const tenant = currentTenantId() || "unknown";

  platformLog("info", "publish", {
    tenant,
    mode,
    target,
    hasImage,
    imageOutcome: !hasImage ? "none"
      : mode === "text-posting" ? "ignored"
      : "attached"
  });

  if (mode === "text-posting") {
    if (hasImage) {
      platformLog("warn", "linkedin_image_ignored_text_posting_mode", {
        source: (imageBytes && imageBytes.buffer) ? "stored" : "url",
        reason: "LINKEDIN_PUBLISH_MODE=text-posting does not support images"
      });
    }
    if (target === "organization") {
      throw new Error(
        "Organization publishing requires LINKEDIN_PUBLISH_MODE=rest; " +
        "text-posting mode authors as the personal profile only"
      );
    }
    return legacyPublishPost(content, hashtags);
  }

  return restPublish(content, hashtags, imageUrl, target, imageBytes);
}

// Re-export for callers that need to check the mode
export { getPublishMode };
