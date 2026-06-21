// ═══════════════════════════════════════════════════════════════
// template-crypto.js   (PLACEHOLDER — no real cryptography yet)
// ═══════════════════════════════════════════════════════════════
// Generic, abstract stubs for a future cryptographic operation over a
// template's PLAINTEXT, computed before the template is encrypted.
// Names are intentionally generic — the real operation, what it
// produces, and whether the result is persisted are all undecided
// (see the open design questions noted at the call site). Change or
// remove freely.
//
// Empty by design: each function logs and returns a neutral value so
// the seam exists and can be wired without committing to a scheme.
// ═══════════════════════════════════════════════════════════════

/**
 * Compute a fingerprint over the template plaintext (placeholder).
 * Intended to run BEFORE encryption, while the plaintext is in hand.
 *
 * @param {string} plaintext — the template text
 * @returns {string|null} — placeholder; always null until implemented
 */
export function computeTemplateFingerprint(plaintext) {
  const len = typeof plaintext === "string" ? plaintext.length : 0;
  console.log("[template-crypto] computeTemplateFingerprint (placeholder) — chars:", len);
  return null;
}

/**
 * Verify a previously computed fingerprint against the plaintext
 * (placeholder). No-op until a scheme is chosen.
 *
 * @param {string} plaintext — the template text
 * @param {string|null} fingerprint — value to verify against
 * @returns {boolean} — placeholder; always true until implemented
 */
export function verifyTemplateFingerprint(plaintext, fingerprint) {
  console.log("[template-crypto] verifyTemplateFingerprint (placeholder)");
  return true;
}
