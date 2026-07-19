// ═══════════════════════════════════════════════════════════════
// src/image/strip-metadata.js - provenance metadata removal
// ═══════════════════════════════════════════════════════════════
// Vendor-generated images arrive carrying embedded metadata,
// including C2PA Content Credentials (OpenAI signs its outputs), XMP,
// and EXIF. Platforms like LinkedIn read and surface these. Per the
// 2.5.21 ruling, stored images are stripped of metadata at store
// time so published media carries none.
//
// Pure Node, no dependencies, whitelist philosophy:
//   PNG : keep only structural and color chunks (IHDR, PLTE, IDAT,
//         IEND, transparency, gamma, color profile, physical dims,
//         APNG animation). Everything else is dropped, which removes
//         tEXt/zTXt/iTXt (XMP), eXIf, tIME, and caBX (C2PA JUMBF),
//         plus any unknown ancillary chunk.
//   JPEG: drop APP1 (EXIF/XMP), APP11 (JUMBF/C2PA), and COM
//         segments; copy everything else verbatim; from SOS onward
//         the entropy-coded data is copied untouched.
//   Other formats return the original bytes unmodified with
//   stripped: false, so the caller can log honestly.
//
// Failure posture: hostile or malformed structure throws a typed
// Error; the STORE decides availability (it logs a warning and keeps
// the original rather than losing a paid render).
// ═══════════════════════════════════════════════════════════════

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs",
  "acTL", "fcTL", "fdAT"
]);

function parseError(msg) {
  const err = new Error(msg);
  err.code = "METADATA_PARSE_FAILED";
  return err;
}

export function stripPng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIG)) {
    throw parseError("Not a PNG signature");
  }
  const parts = [PNG_SIG];
  let off = 8;
  let sawEnd = false;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    if (len > bytes.length - off - 12) throw parseError("PNG chunk length exceeds buffer");
    const type = bytes.subarray(off + 4, off + 8).toString("latin1");
    const total = 12 + len;                       // len + type + data + crc
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(off, off + total));
    if (type === "IEND") { sawEnd = true; off += total; break; }
    off = off + total;
  }
  if (!sawEnd) throw parseError("PNG ended without IEND");
  return Buffer.concat(parts);
}

const JPEG_DROP = new Set([0xe1, 0xeb, 0xfe]);    // APP1, APP11, COM

export function stripJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw parseError("Not a JPEG SOI");
  }
  const parts = [bytes.subarray(0, 2)];
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) throw parseError("JPEG marker misaligned");
    const marker = bytes[off + 1];
    if (marker === 0xda) {                        // SOS: entropy data follows, copy the rest
      parts.push(bytes.subarray(off));
      return Buffer.concat(parts);
    }
    if (marker === 0xd9) {                        // EOI with no scan
      parts.push(bytes.subarray(off, off + 2));
      return Buffer.concat(parts);
    }
    const len = bytes.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > bytes.length) throw parseError("JPEG segment length exceeds buffer");
    if (!JPEG_DROP.has(marker)) parts.push(bytes.subarray(off, off + 2 + len));
    off = off + 2 + len;
  }
  throw parseError("JPEG ended without SOS or EOI");
}

// Dispatch by mime. Returns { bytes, stripped } and never mutates the
// input buffer.
export function stripImageMetadata(bytes, mime) {
  if (!Buffer.isBuffer(bytes)) throw parseError("stripImageMetadata requires a Buffer");
  const m = typeof mime === "string" ? mime.toLowerCase() : "";
  if (m === "image/png") return { bytes: stripPng(bytes), stripped: true };
  if (m === "image/jpeg" || m === "image/jpg") return { bytes: stripJpeg(bytes), stripped: true };
  return { bytes, stripped: false };              // webp and others: honest passthrough
}
