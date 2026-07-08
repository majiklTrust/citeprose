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

// content: post text; hashtags: string[] appended on a blank line
// exactly as the org publisher always has; imageUrn optional.
export function buildRestPostBody({ authorUrn, content, hashtags = [], imageUrn = null, title = null } = {}) {
  if (!isValidAuthorUrn(authorUrn)) {
    throw new Error("post request requires a valid person or organization author URN");
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("post request requires non-empty content");
  }
  const tags = Array.isArray(hashtags)
    ? hashtags.filter((h) => typeof h === "string" && h.trim().length > 0)
    : [];
  const hashtagString = tags.length > 0 ? `\n\n${tags.join(" ")}` : "";

  const payload = {
    author: authorUrn,
    commentary: `${content}${hashtagString}`,
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
