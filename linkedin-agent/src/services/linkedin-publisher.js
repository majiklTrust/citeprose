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
//   LINKEDIN_PUBLISH_MODE=rest    — /rest/posts (default, supports images)
//   LINKEDIN_PUBLISH_MODE=legacy  — /v2/ugcPosts (text-only, current behavior)
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
import {
  getLinkedInAccessToken,
  getLinkedInPersonUrn,
  getLinkedInOrgUrn
} from "../tenant/credential-store.js";
import { isSafeUrl } from "./security.js";

// ── Constants ────────────────────────────────────────────────

const LINKEDIN_REST = "https://api.linkedin.com/rest";

// ── Configuration ────────────────────────────────────────────
// All env-driven with safe defaults. Validated at read time.

function getPublishMode() {
  const mode = (process.env.LINKEDIN_PUBLISH_MODE || "legacy").toLowerCase();
  return mode === "rest" ? "rest" : "legacy";
}

function getPublishTarget() {
  // Controls which LinkedIn identity is used as the post author.
  //   personal     — urn:li:person:{id} from linkedin_person_urn (default)
  //   organization — urn:li:organization:{id} from linkedin_org_urn
  //
  // Switching is a .env change + restart. Both URNs coexist in
  // the credentials table — no re-authentication needed.
  const target = (process.env.LINKEDIN_PUBLISH_TARGET || "personal").toLowerCase();
  return target === "organization" ? "organization" : "personal";
}

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

async function restPublish(content, hashtags, imageUrl) {
  let token, authorUrn;
  const target = getPublishTarget();

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

  const hashtagString = hashtags.length > 0
    ? `\n\n${hashtags.join(" ")}`
    : "";
  const fullContent = `${content}${hashtagString}`;

  // Build the post payload
  const payload = {
    author: authorUrn,
    commentary: fullContent,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  };

  // Upload image if provided
  if (imageUrl) {
    platformLog("info", "linkedin_image_download_start", { imageUrl });

    const { buffer, contentType } = await downloadImage(imageUrl);

    platformLog("info", "linkedin_image_downloaded", {
      bytes: buffer.length,
      contentType
    });

    const imageUrn = await uploadImageToLinkedIn(
      token, authorUrn, buffer, contentType
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
      contentLength: fullContent.length,
      hasImage: !!imageUrl,
      mode: "rest",
      target: getPublishTarget()
    });

    platformLog("info", "linkedin_post_published", {
      postId, hasImage: !!imageUrl, mode: "rest",
      target: getPublishTarget()
    });

    return { success: true, postId };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    const statusCode = err.response?.status;

    await logActivity("error", "linkedin_post_failed", {
      status: statusCode,
      error: errorDetail,
      hasImage: !!imageUrl,
      mode: "rest",
      target: getPublishTarget()
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
//
// In legacy mode, imageUrl is ignored with a warning.

export async function publishPost(content, hashtags = [], imageUrl = null) {
  const mode = getPublishMode();

  if (mode === "legacy") {
    if (imageUrl) {
      platformLog("warn", "linkedin_image_ignored_legacy_mode", {
        imageUrl,
        reason: "LINKEDIN_PUBLISH_MODE=legacy does not support images"
      });
    }
    return legacyPublishPost(content, hashtags);
  }

  return restPublish(content, hashtags, imageUrl);
}

// Re-export for callers that need to check the mode
export { getPublishMode };
