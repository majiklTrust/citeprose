// =================================================================
// src/services/linkedin-post-request.js, shared post request shape
// =================================================================
// ONE home for the REST /posts payload both publishers send. The
// org publisher and the advocacy publisher differ only in whose
// token and whose author URN they use; the request shape is
// identical by construction because both build it here. Extracted
// in Step 3 so the advocacy publisher provably cannot drift the
// org publisher's request (design suite pins the org publisher to
// this builder).
//
// Pure module: zero imports, fully testable.
// =================================================================

const AUTHOR_URN_RE = /^urn:li:(person|organization):[A-Za-z0-9_-]+$/;

export function isValidAuthorUrn(urn) {
  return typeof urn === "string" && AUTHOR_URN_RE.test(urn);
}

// ── little text escaping (4.25111.6 truncation fix) ─────────────
// The /rest/posts commentary field is NOT plain text: it is
// LinkedIn's "little" text format, and these fifteen characters
// are reserved syntax that must each be backslash-escaped to
// render as plaintext (spec: learn.microsoft.com, little-text-format:
// "All reserved characters need to be escaped with a backslash,
// even if those characters are not used in one of the supported
// elements or templates."). Sent raw, the parser consumes the
// first reserved character as syntax and the published post
// truncates at that exact point; a draft containing "(source)"
// published only up to the open parenthesis.
//
// Escaping happens HERE, at the wire-format seam, and only here:
// the stored post content stays raw prose (the DB is the source
// of truth; the dashboard, editor, and analytics never see
// escapes). One regex pass with the backslash inside the class,
// so escape characters are never themselves re-escaped.
const LITTLE_TEXT_RESERVED = /[\\|{}@[\]()<>#*_~]/g;

export function escapeLittleText(text) {
  if (typeof text !== "string") return "";
  return text.replace(LITTLE_TEXT_RESERVED, (c) => "\\" + c);
}

// A hashtag's leading # must stay UNESCAPED so LinkedIn still
// recognizes the tag entity; only the tag body is escaped (a
// defensive no-op for the alphanumeric tags the generator emits).
function escapeHashtag(tag) {
  const t = tag.trim();
  return t.startsWith("#") ? "#" + escapeLittleText(t.slice(1)) : escapeLittleText(t);
}

// ── wire-length gate (4.25111.7) ────────────────────────────────
// LinkedIn caps post commentary at 3,000 characters. The cap is
// checked on the WIRE string (escaped content plus hashtag line),
// never on the stored draft: escaping adds one character per
// reserved character, so a draft can pass a raw-length check and
// still exceed the limit as sent. Measuring the escaped form is
// the conservative reading (the docs do not state whether escapes
// count toward the limit); it can only refuse a marginal post
// early, never send one that bounces. Pure computation, no I/O:
// every caller on every node measures identically, and a future
// UX counter can display the same number by calling the same
// function, so the two layers cannot disagree.
export function getCommentaryMax() {
  const raw = parseInt(process.env.LINKEDIN_COMMENTARY_MAX, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

// The single composition rule: what buildRestPostBody sends is
// exactly what this returns. Callers pre-flight with it so the
// measured string and the sent string can never drift.
export function composeWireCommentary(content, hashtags = []) {
  const tags = Array.isArray(hashtags)
    ? hashtags.filter((h) => typeof h === "string" && h.trim().length > 0)
    : [];
  const hashtagString = tags.length > 0 ? `\n\n${tags.map(escapeHashtag).join(" ")}` : "";
  return `${escapeLittleText(typeof content === "string" ? content : "")}${hashtagString}`;
}

export function commentaryTooLongError(wireLength, max) {
  const err = new Error(
    `This post is ${wireLength} characters after LinkedIn formatting escapes are applied, `
    + `${wireLength - max} over LinkedIn's ${max}-character limit. `
    + `Please shorten it and try again. Your draft is unchanged.`
  );
  err.code = "COMMENTARY_TOO_LONG";
  err.details = { wireLength, limit: max, overBy: wireLength - max };
  return err;
}

// content: post text; hashtags: string[] appended on a blank line
// exactly as the org publisher always has; imageUrn optional.
export function buildRestPostBody({ authorUrn, content, hashtags = [], imageUrn = null, title = null } = {}) {
  if (!isValidAuthorUrn(authorUrn)) {
    throw new Error("post request requires a valid person or organization author URN");
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("post request requires non-empty content");
  }
  const commentary = composeWireCommentary(content, hashtags);
  const max = getCommentaryMax();
  if (commentary.length > max) {
    // Defense in depth: callers pre-flight before any state change;
    // this throw guarantees no caller, present or future, reaches
    // the network with an oversize commentary. It fires before the
    // publisher's image upload, so refusal always precedes spend.
    throw commentaryTooLongError(commentary.length, max);
  }

  const payload = {
    author: authorUrn,
    commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  };
  if (imageUrn) {
    payload.content = {
      media: { id: imageUrn, ...(title ? { title } : {}) }
    };
  }
  return payload;
}
