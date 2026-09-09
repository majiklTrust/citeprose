// =================================================================
// Stripe payments provider (2.3.6). DORMANT until activation:
// PAYMENTS_PROVIDER=local remains the default; setting it to
// "stripe" plus STRIPE_WEBHOOK_SECRET brings this adapter live.
//
// No Stripe SDK: signature verification is pure crypto over the
// RAW body (HMAC-SHA256 of "timestamp.payload" against the
// endpoint secret), constant-time, with a replay tolerance
// window. Zero new dependencies; the seam stays clean.
//
// ACTIVATION CHECKLIST (when the Stripe account unlocks):
//   1. Create one price per tier in TIERS (config/entitlements.js)
//      with metadata.tier set accordingly.
//   2. Checkout sessions must carry metadata.tenant_id (and
//      metadata.trial = "true" where the grace period applies);
//      subscriptions created from them should copy both so
//      invoice events inherit the mapping.
//   3. Point the webhook endpoint at /api/payments/webhook and
//      set STRIPE_WEBHOOK_SECRET from the endpoint's whsec_ value.
//   4. Set PAYMENTS_PROVIDER=stripe and restart.
// =================================================================

import crypto from "node:crypto";
import { platformLog } from "../../services/platform-log.js";

// 4.25111.58: a refused webhook used to return null with no record,
// so a wrong STRIPE_WEBHOOK_SECRET in production refused every
// subscription event silently. Each refusal now names its reason in
// the platform log. Never the body, never the signature: the header
// presence flags are the only request facts that ride along.
function refuse(reason, headers) {
  platformLog("warn", "payment_webhook_rejected", {
    provider: "stripe", reason,
    hasSignatureHeader: !!(headers && headers["stripe-signature"])
  });
  return null;
}

const UUID_SHAPE = /^[0-9a-f-]{36}$/;

function toleranceSeconds() {
  const v = Number(process.env.PAYMENTS_STRIPE_TOLERANCE_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 300;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>][,v0=<hex>]
function parseSignatureHeader(header) {
  if (typeof header !== "string" || !header) return null;
  const out = { t: null, v1: [] };
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") out.t = v;
    else if (k === "v1") out.v1.push(v);
  }
  if (!out.t || out.v1.length === 0) return null;
  return out;
}

function verifySignature(headers, rawBody, secret, nowSeconds) {
  const sig = parseSignatureHeader(headers["stripe-signature"]);
  if (!sig) return false;
  const ts = Number(sig.t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > toleranceSeconds()) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(`${sig.t}.${rawBody.toString("utf8")}`)
    .digest("hex");
  return sig.v1.some((candidate) => safeEqual(candidate, expected));
}

// The tenant mapping rides Stripe metadata, set at checkout
// creation per the activation checklist. Every fallback is a
// place Stripe legitimately carries it; anything else refuses.
function extractTenantId(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.metadata && obj.metadata.tenant_id,
    obj.client_reference_id,
    obj.subscription_details && obj.subscription_details.metadata && obj.subscription_details.metadata.tenant_id,
    obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.metadata
      && obj.parent.subscription_details.metadata.tenant_id
  ];
  for (const c of candidates) {
    if (typeof c === "string" && UUID_SHAPE.test(c)) return c;
  }
  return null;
}

// Stripe event type -> normalized lifecycle event type.
function extractSubscriptionRef(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.subscription,
    obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^sub_[A-Za-z0-9]+$/.test(c)) return c;
  }
  return null;
}

const TYPE_MAP = {
  "checkout.session.completed": "checkout_completed",
  "invoice.payment_succeeded": "payment_succeeded",
  "invoice.paid": "payment_succeeded",
  "invoice.payment_failed": "payment_failed",
  "invoice.marked_uncollectible": "dunning_exhausted",
  "customer.subscription.deleted": "subscription_cancelled"
};

export const stripeProvider = {
  name: "stripe",

  // (headers, rawBody Buffer) -> normalized event | { ignored } | null
  // null        = unverifiable (route answers 401; Stripe retries)
  // { ignored } = verified but not lifecycle-relevant (route
  //               answers 200 so Stripe stops retrying)
  parseWebhook(headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return refuse("STRIPE_WEBHOOK_SECRET is not set", headers);
    if (!Buffer.isBuffer(rawBody)) return refuse("raw body unavailable (json parser ran first?)", headers);
    if (!verifySignature(headers, rawBody, secret, nowSeconds)) return refuse("signature missing, malformed, stale, or wrong", headers);

    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch { return refuse("signed body is not JSON", headers); }
    if (!body || typeof body !== "object" || typeof body.type !== "string") return refuse("signed body has no event type", headers);

    const mapped = TYPE_MAP[body.type];
    if (!mapped) return { ignored: true, reason: `stripe event ${body.type} is not lifecycle-relevant` };

    const obj = body.data && body.data.object;
    const tenantId = extractTenantId(obj);
    // 4.25111.78: the Stripe customer and subscription travel with the
    // event. A checkout session names both; an invoice names the
    // subscription (top level on older API versions, under
    // parent.subscription_details on Basil and later). A message with
    // no tenant id but a subscription reference is still deliverable:
    // the lifecycle resolves the tenant by the reference it recorded
    // at checkout. With neither, nothing can be mapped and the event
    // is ignored as before.
    const providerCustomerRef = obj && typeof obj.customer === "string" ? obj.customer : null;
    const providerSubscriptionRef = extractSubscriptionRef(obj);
    if (!tenantId && !providerSubscriptionRef) return { ignored: true, reason: "verified event carries no tenant mapping" };

    return {
      type: mapped,
      tenantId,
      tier: obj && obj.metadata && typeof obj.metadata.tier === "string" ? obj.metadata.tier : null,
      trial: !!(obj && obj.metadata && obj.metadata.trial === "true"),
      providerEventRef: typeof body.id === "string" ? `stripe:${body.id}` : null,
      providerCustomerRef,
      providerSubscriptionRef,
      occurredAt: Number.isFinite(body.created) ? new Date(body.created * 1000).toISOString() : null
    };
  }
};
