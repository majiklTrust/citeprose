// =================================================================
// src/services/advocacy-publisher.js, member publishing (FR-P2-07)
// =================================================================
// Publishes an APPROVED variant to the member's own profile, using
// the MEMBER's access token and person URN from member_credentials.
// The request shape comes from the shared builder, so this module
// provably cannot drift the org publisher's payload; the org
// publisher's tenant-credential path is never imported here.
//
// Attribution (FR-P2-07): every publish logs member sub, variant
// id, and source post id. Never content, never tokens.
//
// Per the signed design, a publish failure classifies through the
// LinkedIn failure taxonomy and marks the variant failed with the
// code; the reviewer verdict already stored in quality is
// preserved and the publish error is merged alongside it.
//
// Auto mode (TD-5): a member who opted in publishes automatically,
// capped per member by the SAME cadence constants the tenant
// pipeline uses (MIN_HOURS_BETWEEN_POSTS, MAX_POSTS_PER_10_DAYS).
// The caps decision is a pure function below.
// =================================================================

import { getLinkedInRestBase, getLinkedInApiVersion, getAnalyticsTimeoutMs } from "../config/analytics.js";
import { LI_ERROR_CODES, liError, classifyLinkedInFailure, isLinkedInApiError } from "./linkedin-errors.js";
import { buildRestPostBody } from "./linkedin-post-request.js";

// Same env constants the tenant scheduler applies (TD-5).
export function getAdvocacyMinHoursBetween() {
  return Number.parseInt(process.env.MIN_HOURS_BETWEEN_POSTS || "72", 10);
}
export function getAdvocacyMaxPer10Days() {
  return Number.parseInt(process.env.MAX_POSTS_PER_10_DAYS || "4", 10);
}

// -- Pure caps decision ------------------------------------------
export function canAutoPublishDecision({ recentCount, maxPer10Days, lastPublishedAtMs, minHoursBetween, nowMs } = {}) {
  const cap = Number.isFinite(maxPer10Days) && maxPer10Days > 0 ? maxPer10Days : 0;
  if (cap === 0) return { allowed: false, reason: "auto publishing cap is zero" };
  // Unknown recent count refuses (fail closed): auto mode never
  // publishes on missing bookkeeping.
  if (!Number.isFinite(recentCount)) {
    return { allowed: false, reason: "recent publish count unknown" };
  }
  if (recentCount >= cap) {
    return { allowed: false, reason: `member reached ${recentCount} of ${cap} posts in the rolling 10 days` };
  }
  if (Number.isFinite(lastPublishedAtMs) && Number.isFinite(nowMs) && Number.isFinite(minHoursBetween)) {
    const hoursSince = (nowMs - lastPublishedAtMs) / 3600000;
    if (hoursSince < minHoursBetween) {
      return { allowed: false, reason: `only ${Math.floor(hoursSince)}h since the member's last auto post; minimum is ${minHoursBetween}h` };
    }
  }
  return { allowed: true, reason: "within caps" };
}

// -- Egress guard (house policy) ---------------------------------
function assertPublishUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "advocacy publish URL is not a valid URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "advocacy publish refuses non-https egress");
  }
  if (parsed.username || parsed.password) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "advocacy publish refuses URL-embedded credentials");
  }
}

// -- Network core (deps-injectable, DB-free) ---------------------
// Returns { linkedinId }. Throws typed on every failure, including
// a 2xx that carries no post id (silent success is a lie).
export async function publishVariantCore({ content, hashtags, personUrn, accessToken }, deps = {}) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw liError(LI_ERROR_CODES.NOT_CONNECTED, "member access token missing");
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const base = deps.base || getLinkedInRestBase();
  const apiVersion = deps.apiVersion || getLinkedInApiVersion();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : getAnalyticsTimeoutMs();

  const body = buildRestPostBody({ authorUrn: personUrn, content, hashtags });
  const url = `${base}/posts`;
  assertPublishUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": apiVersion,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw liError(LI_ERROR_CODES.NETWORK, "advocacy publish network failure", {
      endpoint: "/posts", cause: err?.name || "fetch_failed"
    });
  }
  clearTimeout(timer);

  if (!response.ok) {
    let text = "";
    try { text = await response.text(); } catch { text = ""; }
    throw classifyLinkedInFailure(response.status, text, "/posts");
  }
  const headerId = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("x-restli-id") : null;
  if (typeof headerId !== "string" || headerId.length === 0) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "publish accepted but returned no post id", {
      endpoint: "/posts", status: response.status
    });
  }
  return { linkedinId: headerId };
}

// -- DB orchestration (runs INSIDE withTenant) --------------------
// Publishes one variant owned by memberSub currently at 'approved'.
export async function publishApprovedVariant(variantId, memberSub, opts = {}) {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("advocacy publish requires tenant context");

  const { rows } = await c.query(
    `SELECT id, member_sub, source_post_id, content, hashtags
       FROM advocacy_variants
      WHERE id = $1 AND member_sub = $2 AND status = 'approved'`,
    [variantId, memberSub]
  );
  if (rows.length === 0) return { status: "not_publishable" };
  const variant = rows[0];

  const { logActivity } = await import("./database.js");
  let creds;
  try {
    const mc = await import("../tenant/member-credential-store.js");
    creds = {
      accessToken: await mc.fetchMemberCredential(memberSub, "linkedin_access_token"),
      personUrn: await mc.fetchMemberCredential(memberSub, "linkedin_person_urn")
    };
  } catch {
    creds = null;
  }

  const failVariant = async (code) => {
    await c.query(
      `UPDATE advocacy_variants
          SET status = 'failed',
              quality = COALESCE(quality, '{}'::jsonb) || jsonb_build_object('publish', jsonb_build_object('code', $2::text)),
              resolved_at = COALESCE(resolved_at, now())
        WHERE id = $1`,
      [variantId, code]
    );
    await logActivity("warn", "advocacy_post_publish_failed", {
      variantId, sourcePostId: variant.source_post_id, code, autoMode: !!opts.auto
    }, memberSub);
    return { status: "publish_failed", code };
  };

  if (!creds) {
    return failVariant(LI_ERROR_CODES.NOT_CONNECTED);
  }

  let published;
  try {
    published = await publishVariantCore({
      content: variant.content,
      hashtags: Array.isArray(variant.hashtags) ? variant.hashtags : [],
      personUrn: creds.personUrn,
      accessToken: creds.accessToken
    }, opts.deps || {});
  } catch (err) {
    const code = isLinkedInApiError(err) ? err.code : LI_ERROR_CODES.NETWORK;
    return failVariant(code);
  }

  await c.query(
    `UPDATE advocacy_variants
        SET status = 'published', linkedin_id = $2, published_at = now(),
            reach_at_publish = (SELECT connections_size FROM advocacy_members
                                 WHERE auth_sub = $3)
      WHERE id = $1`,
    [variantId, published.linkedinId, memberSub]
  );
  // FR-P2-07 attribution: who, which variant, which source post.
  await logActivity("info", "advocacy_post_published", {
    variantId, sourcePostId: variant.source_post_id, autoMode: !!opts.auto
  }, memberSub);
  return { status: "published", linkedinId: published.linkedinId };
}

// -- Auto mode (runs INSIDE withTenant) ---------------------------
// Called by the generation fan-out for a freshly queued variant of
// an auto-opted-in, connected member. Enforces the caps; a capped
// variant STAYS pending_approval for manual handling.
export async function maybeAutoPublish(variantId, memberSub) {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("auto publish requires tenant context");

  const member = await c.query(
    "SELECT mode, connected FROM advocacy_members WHERE auth_sub = $1",
    [memberSub]
  );
  if (member.rows.length === 0 || member.rows[0].mode !== "auto" || member.rows[0].connected !== true) {
    return { status: "not_auto" };
  }

  const stats = await c.query(
    `SELECT COUNT(*) FILTER (WHERE published_at > now() - interval '10 days')::int AS recent,
            EXTRACT(EPOCH FROM MAX(published_at)) * 1000 AS last_ms
       FROM advocacy_variants
      WHERE member_sub = $1 AND status = 'published'`,
    [memberSub]
  );
  const decision = canAutoPublishDecision({
    recentCount: stats.rows[0].recent,
    maxPer10Days: getAdvocacyMaxPer10Days(),
    lastPublishedAtMs: stats.rows[0].last_ms === null ? null : Number(stats.rows[0].last_ms),
    minHoursBetween: getAdvocacyMinHoursBetween(),
    nowMs: Date.now()
  });
  const { logActivity } = await import("./database.js");
  if (!decision.allowed) {
    await logActivity("info", "advocacy_auto_capped", { variantId, reason: decision.reason }, memberSub);
    return { status: "capped", reason: decision.reason };
  }

  const approved = await c.query(
    `UPDATE advocacy_variants
        SET status = 'approved', resolved_at = now()
      WHERE id = $1 AND member_sub = $2 AND status = 'pending_approval'
      RETURNING id`,
    [variantId, memberSub]
  );
  if (approved.rowCount === 0) return { status: "not_publishable" };
  return publishApprovedVariant(variantId, memberSub, { auto: true });
}
