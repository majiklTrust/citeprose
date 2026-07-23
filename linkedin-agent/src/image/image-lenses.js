// ═══════════════════════════════════════════════════════════════
// src/image/image-lenses.js - Phase 3 storytelling: the Story Lenses
// ═══════════════════════════════════════════════════════════════
// The six Story Lenses from the approved concept, as DATA. A lens is
// a reusable visual treatment applied to a grounded prompt or brief;
// it never changes WHAT the image is about, only HOW it is told.
//
// HARD RULE, enforced by the design suite: no lens name, description,
// directive, or negative contains a DIGIT. Lens composition runs
// AFTER the verified-metric fidelity lock, so lens data that carried
// a number could smuggle an unverified figure past the lock. Keeping
// the data digit-free makes that structurally impossible.
//
// The brand palette is OWNER-authored tenant config (agent_state key
// image_brand_palette) applied at composition time. It is sanitized
// defensively here as well as at the admin write: template braces are
// stripped so a palette can never smuggle a {{METRIC_...}} token into
// a post-lock prompt, control characters are removed, and length is
// clamped.
//
// Pure module: no I/O, no DB, importable anywhere, unit-testable.
// ═══════════════════════════════════════════════════════════════

import { imageError, IMAGE_ERROR_CODES } from "./errors.js";

export const PALETTE_MAX_CHARS = 240;

export const LENSES = Object.freeze([
  Object.freeze({
    id: "data_hero",
    name: "Data Hero",
    description: "One metric, monumental",
    directive: "Style lens, Data Hero: one dominant visual element rendered monumental and central, minimalist negative space, strong figure-ground contrast, a single focal subject treated like a landmark.",
    negative: "charts, graphs, readable numerals, dashboards"
  }),
  Object.freeze({
    id: "concept_metaphor",
    name: "Concept Metaphor",
    description: "Idea as a scene",
    directive: "Style lens, Concept Metaphor: translate the core idea into a single physical scene, with literal objects standing in for abstract forces, cinematic composition, clean deliberate staging.",
    negative: "collage, split panels, floating icons"
  }),
  Object.freeze({
    id: "editorial_photo",
    name: "Editorial Photo",
    description: "Documentary realism",
    directive: "Style lens, Editorial Photo: documentary photographic realism, natural light, candid framing, shallow depth of field, the feel of a magazine feature photograph.",
    negative: "illustration, cartoon, surreal rendering"
  }),
  Object.freeze({
    id: "diagram_real",
    name: "Diagram-Real",
    description: "Clean explainer",
    directive: "Style lens, Diagram-Real: a clean explanatory composition, isometric or overhead clarity, simplified shapes with real material textures, instructional calm, generous whitespace.",
    negative: "text labels, arrows with captions, clutter"
  }),
  Object.freeze({
    id: "announcement",
    name: "Announcement",
    description: "Bold, event-like",
    directive: "Style lens, Announcement: bold celebratory energy, event-scale staging, dramatic lighting, a sense of unveiling, confident central composition.",
    negative: "banner text, confetti overload, party-store props"
  }),
  Object.freeze({
    id: "human_moment",
    name: "Human Moment",
    description: "People-centered",
    directive: "Style lens, Human Moment: people-centered warmth, authentic working moments, genuine expression, environmental context, respectful and varied portrayal of people.",
    negative: "stock-photo stiffness, forced smiles, identifiable real individuals"
  })
]);

export function listLenses() {
  return LENSES.map((l) => ({ id: l.id, name: l.name, description: l.description }));
}

// Fail-closed lens lookup: an unknown id is a typed error, never a
// silent no-style fallback, so a typo cannot ship an unstyled image
// the operator believed was styled.
export function requireLens(lensId) {
  const found = LENSES.find((l) => l.id === lensId);
  if (!found) {
    throw imageError(IMAGE_ERROR_CODES.UNKNOWN_LENS,
      `Unknown story lens "${lensId}"`,
      { lensId, supported: LENSES.map((l) => l.id) });
  }
  return found;
}

// Defensive palette sanitization (also validated at the admin write):
// template braces out (token smuggling), control characters out,
// length clamped. Returns null when nothing usable remains.
export function sanitizePalette(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[{}]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PALETTE_MAX_CHARS);
  return cleaned === "" ? null : cleaned;
}

// Compose the final prompt: base first (the grounded, lock-checked
// content), then the lens treatment, then the brand palette, then any
// aspect composition guidance. Negatives merge: caller's first, then
// the lens negatives. Pure string assembly, no I/O.
export function applyLens(basePrompt, opts = {}) {
  const base = typeof basePrompt === "string" ? basePrompt.trim() : "";
  const lens = opts.lens || null;
  const palette = sanitizePalette(opts.palette);
  const guidance = typeof opts.aspectGuidance === "string" && opts.aspectGuidance.trim() !== ""
    ? opts.aspectGuidance.trim() : null;

  const parts = [base];
  if (lens) parts.push(lens.directive);
  if (palette) parts.push(`Brand palette: ${palette}.`);
  if (guidance) parts.push(guidance);

  const negatives = [];
  if (typeof opts.negativePrompt === "string" && opts.negativePrompt.trim() !== "") {
    negatives.push(opts.negativePrompt.trim());
  }
  if (lens && lens.negative) negatives.push(lens.negative);

  return Object.freeze({
    prompt: parts.filter(Boolean).join(" "),
    negativePrompt: negatives.length > 0 ? negatives.join(", ") : null,
    lensId: lens ? lens.id : null
  });
}
