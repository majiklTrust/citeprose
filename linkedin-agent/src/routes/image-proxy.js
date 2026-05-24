// ═══════════════════════════════════════════════════════════════
// src/routes/image-proxy.js — Server-side proxy for article images
// ═══════════════════════════════════════════════════════════════
//
// The browser never fetches external image URLs directly. All
// dashboard thumbnails route through this endpoint, which:
//   1. Validates the URL (SSRF guard via isSafeUrl)
//   2. Fetches the image with browser-like headers
//   3. Validates magic bytes — never trusts external Content-Type
//   4. Returns the binary with cache headers
//
// Browser-like headers are required because most CDNs and news
// sites block bot User-Agents and check Referer for hotlink
// protection. The proxy mimics a browser image sub-resource
// request to pass these checks.
//
// Diagnostic logging on every request (success and failure) so
// proxy issues are visible in the console without needing the
// browser DevTools network tab.
//
// Security:
//   • Requires authentication + view_dashboard permission
//   • SSRF guard blocks private IPs, localhost, non-HTTPS
//   • Magic byte validation rejects non-image payloads
//   • Size cap prevents memory abuse
//   • X-Content-Type-Options: nosniff prevents MIME sniffing
//   • Cache-Control: private — never cached by shared proxies
// ═══════════════════════════════════════════════════════════════

import { isSafeUrl } from "../services/security.js";
import { platformLog } from "../services/platform-log.js";

// ── Configuration ────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024;  // 5 MB cap for thumbnails
const TIMEOUT_MS = 15000;           // 15 second fetch timeout

const MAGIC = [
  { type: "image/jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { type: "image/png",  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { type: "image/gif",  bytes: [0x47, 0x49, 0x46] },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }
];

// Browser-like User-Agent. CDNs commonly block requests with
// bot-like or unknown UA strings. This mimics a standard Chrome
// sub-resource fetch for an image.
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── Handler ─────────────────────────────────────────────────

export async function handleImageProxy(req, res) {
  const url = req.query.url;

  if (!url || typeof url !== "string" || !isSafeUrl(url)) {
    platformLog("warn", "image_proxy_rejected", { url: url || "(empty)", reason: "failed isSafeUrl" });
    return res.status(400).json({ error: "Invalid or unsafe image URL" });
  }

  // Build a Referer from the image URL's origin. Many CDNs
  // allow requests that appear to originate from their own site.
  let referer;
  try {
    const parsed = new URL(url);
    referer = parsed.origin;
  } catch {
    referer = "";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept": "image/jpeg,image/webp,image/png,image/gif,*/*;q=0.1",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": referer,
          "Sec-Fetch-Dest": "image",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "cross-site"
        },
        redirect: "follow",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const extStatus = response.status;
    const extContentType = response.headers.get("content-type") || "(none)";

    if (!response.ok) {
      platformLog("warn", "image_proxy_upstream_error", { url, status: extStatus, contentType: extContentType });
      return res.status(502).json({ error: "Image source returned an error" });
    }

    // Stream with size cap
    const chunks = [];
    let totalBytes = 0;
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BYTES) {
        reader.cancel();
        platformLog("warn", "image_proxy_size_exceeded", { url, bytes: totalBytes });
        return res.status(413).json({ error: "Image exceeds size limit" });
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks);

    // Magic byte validation — never trust Content-Type from external source
    const detected = MAGIC.find(m => m.bytes.every((b, i) => buffer[i] === b));
    if (!detected) {
      platformLog("warn", "image_proxy_magic_failed", {
        url, bytes: buffer.length, contentType: extContentType,
        head: buffer.length >= 4 ? `${buffer[0].toString(16)} ${buffer[1].toString(16)} ${buffer[2].toString(16)} ${buffer[3].toString(16)}` : "(too short)"
      });
      return res.status(415).json({ error: "Not a recognized image format" });
    }

    platformLog("info", "image_proxy_ok", {
      url, bytes: buffer.length, type: detected.type
    });

    res.set({
      "Content-Type": detected.type,
      "Content-Length": buffer.length,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    res.send(buffer);
  } catch (err) {
    if (err.name === "AbortError") {
      platformLog("warn", "image_proxy_timeout", { url });
      return res.status(504).json({ error: "Image fetch timed out" });
    }
    platformLog("warn", "image_proxy_error", { url, error: err.message });
    res.status(502).json({ error: "Image fetch failed" });
  }
}
