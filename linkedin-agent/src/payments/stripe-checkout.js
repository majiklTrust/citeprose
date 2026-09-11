// ═══════════════════════════════════════════════════════════════
// stripe-checkout.js: Checkout Sessions minted and verified by the server
// ═══════════════════════════════════════════════════════════════
// 4.25111.82. Purchases no longer use shared Payment Links. A Payment
// Link's client_reference_id is a query parameter the browser writes,
// so anyone could point the official payment page at a purchase row
// (or tenant) of their choosing and have a third party pay it. Here
// the binding between "who is paying" and "what is being paid for" is
// made by this server, inside Stripe's own record, with the Stripe
// key: nothing in the URL the buyer receives can re-point it.
//
//   createCheckoutSession  one session per Purchase click: the tier's
//                          default price (the one the pricing page
//                          shows), the login's email locked on the
//                          payment page, the purchase row id or the
//                          tenant id in metadata (copied to the
//                          subscription so later invoices inherit it),
//                          the application's trial rule, a one hour
//                          expiry, and our return address.
//   verifyCompletedSession the settlement never trusts the webhook's
//                          copy of the facts alone: it reads the session
//                          back from Stripe by id and checks that it is
//                          complete, in subscription mode, paid (or a
//                          trial with nothing due), names exactly one
//                          reference we minted, charged the price of
//                          the tier it claims, and was paid under the
//                          email we locked. Anything else is HELD, not
//                          applied. A transport failure throws so the
//                          webhook answers 500 and Stripe retries.
//   expireCheckoutSession  a second click re-tiers the purchase; the
//                          previous session is closed so only one
//                          payable link exists (best effort).
//
// No SDK: form-encoded POST and JSON GET over native fetch, timeout
// bounded. The key is the one the catalog already uses
// (STRIPE_CATALOG_KEY, raw text in .env; STRIPE_SECRET_KEY remains
// the 3.3.26 fallback name). A restricted key serves as long as it
// carries Products: read, Prices: read and Checkout Sessions: write;
// a create refused by Stripe for a missing permission is logged with
// Stripe's own message. Absent key: purchases are not available and
// the door says so.
// ═══════════════════════════════════════════════════════════════
import { TIERS, trialEligible, getTrialDays } from "../config/entitlements.js";
import { getStripeCatalogKey, getTierPrices, tierForPriceId } from "./stripe-catalog.js";

const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 6000;
const SESSION_TTL_SECONDS = 60 * 60;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_SHAPE = /^cs_[A-Za-z0-9_]+$/;

// One key for every outbound Stripe call the application makes.
export function getStripeCheckoutKey(env = process.env) {
  return getStripeCatalogKey(env);
}

export function isCheckoutAvailable(env = process.env) {
  return getStripeCheckoutKey(env) !== null;
}

// The application's trial rule is the single source of truth for the
// trial the session carries, exactly as the lifecycle uses it to
// compute the trial's end. 0 means no trial.
export function trialDaysFor(tier) {
  return trialEligible(tier) ? getTrialDays() : 0;
}

export class StripeTransportError extends Error {
  constructor(message, status) { super(message); this.name = "StripeTransportError"; this.status = status || null; }
}

async function stripeCall(method, path, key, form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = { Authorization: "Bearer " + key };
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(STRIPE_API + path, { method, headers, body, signal: controller.signal });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, body: json };
  } catch (err) {
    throw new StripeTransportError(err && err.message ? err.message : "stripe unreachable");
  } finally {
    clearTimeout(timer);
  }
}

// subject: "checkout" (a purchase row, no tenant yet) or "tenant".
// Returns { id, url } on success, or { error } naming the reason (an
// input the server refused, or Stripe's own status and message) so
// the door can log it. Never throws for a Stripe refusal.
export async function createCheckoutSession({ subject, referenceId, tier, email, origin }, env = process.env) {
  const key = getStripeCheckoutKey(env);
  if (!key) return { error: "no Stripe key configured" };
  if (!["checkout", "tenant"].includes(subject)) return { error: "unknown subject" };
  if (typeof referenceId !== "string" || !UUID_SHAPE.test(referenceId)) return { error: "reference is not a uuid" };
  if (typeof tier !== "string" || !TIERS.includes(tier)) return { error: "unknown tier" };
  if (typeof email !== "string" || !email.includes("@")) return { error: "no email" };
  if (typeof origin !== "string" || !/^https?:\/\/[^/]+$/.test(origin)) return { error: "origin is not an https origin" };
  const prices = await getTierPrices(env);
  const price = prices && prices[tier] ? prices[tier].priceId : null;
  if (!price) return { error: "no default price for tier " + tier + " in the catalog" };
  const refKey = subject === "tenant" ? "tenant_id" : "checkout_id";
  const trialDays = trialDaysFor(tier);
  const form = {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    customer_email: email,
    client_reference_id: referenceId,
    "metadata[tier]": tier,
    "metadata[trial]": trialDays > 0 ? "true" : "false",
    ["metadata[" + refKey + "]"]: referenceId,
    "subscription_data[metadata][tier]": tier,
    ["subscription_data[metadata][" + refKey + "]"]: referenceId,
    success_url: origin + "/checkout/return",
    cancel_url: origin + (subject === "tenant" ? "/app/billing" : "/pricing.html"),
    expires_at: String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
  };
  if (trialDays > 0) form["subscription_data[trial_period_days]"] = String(trialDays);
  let r;
  try {
    r = await stripeCall("POST", "/checkout/sessions", key, form);
  } catch (err) {
    return { error: "stripe unreachable: " + (err && err.message ? err.message : String(err)) };
  }
  const s = r.body;
  if (!r.ok) {
    const msg = s && s.error && typeof s.error.message === "string" ? s.error.message : "no message";
    return { error: "stripe " + r.status + ": " + msg };
  }
  if (!s || typeof s.id !== "string" || !SESSION_SHAPE.test(s.id) || typeof s.url !== "string" || !s.url.startsWith("https://")) {
    return { error: "stripe answered without a session id and url" };
  }
  return { id: s.id, url: s.url };
}

export async function expireCheckoutSession(sessionId, env = process.env) {
  const key = getStripeCheckoutKey(env);
  if (!key || typeof sessionId !== "string" || !SESSION_SHAPE.test(sessionId)) return false;
  try {
    const r = await stripeCall("POST", "/checkout/sessions/" + encodeURIComponent(sessionId) + "/expire", key, {});
    return r.ok === true;
  } catch {
    return false;
  }
}

function lowerEmail(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

// -> { ok: true, facts } | { ok: false, held: reason }
// throws StripeTransportError when Stripe could not be consulted.
export async function verifyCompletedSession(sessionId, env = process.env) {
  const key = getStripeCheckoutKey(env);
  if (!key) throw new StripeTransportError("no Stripe key configured");
  if (typeof sessionId !== "string" || !SESSION_SHAPE.test(sessionId)) return { ok: false, held: "session reference missing" };
  const r = await stripeCall("GET", "/checkout/sessions/" + encodeURIComponent(sessionId) + "?expand[]=line_items", key, null);
  if (r.status === 404) return { ok: false, held: "session not found at the processor" };
  if (!r.ok || !r.body || typeof r.body !== "object") throw new StripeTransportError("session read failed", r.status);
  const s = r.body;
  if (s.status !== "complete") return { ok: false, held: `session status ${String(s.status)}` };
  if (s.mode !== "subscription") return { ok: false, held: `session mode ${String(s.mode)}` };
  const md = s.metadata && typeof s.metadata === "object" ? s.metadata : {};
  const tier = typeof md.tier === "string" ? md.tier : null;
  if (!tier || !TIERS.includes(tier)) return { ok: false, held: "session names no tier we sell" };
  const trial = md.trial === "true";
  if (s.payment_status === "no_payment_required") {
    if (!trial) return { ok: false, held: "nothing was paid and no trial applies" };
  } else if (s.payment_status !== "paid") {
    return { ok: false, held: `payment status ${String(s.payment_status)}` };
  }
  const checkoutId = typeof md.checkout_id === "string" && UUID_SHAPE.test(md.checkout_id) ? md.checkout_id : null;
  const tenantId = typeof md.tenant_id === "string" && UUID_SHAPE.test(md.tenant_id) ? md.tenant_id : null;
  if ((checkoutId && tenantId) || (!checkoutId && !tenantId)) return { ok: false, held: "session does not name exactly one reference we minted" };
  const locked = lowerEmail(s.customer_email);
  const payer = lowerEmail(s.customer_details && s.customer_details.email);
  if (!locked || !payer || locked !== payer) return { ok: false, held: "payer email differs from the email locked at creation" };
  const items = s.line_items && Array.isArray(s.line_items.data) ? s.line_items.data : [];
  const priceId = items.length === 1 && items[0] && items[0].price && typeof items[0].price.id === "string" ? items[0].price.id : null;
  if (!priceId) return { ok: false, held: "session does not carry exactly one price" };
  const prices = await getTierPrices(env);
  if (!prices) throw new StripeTransportError("catalog unavailable for price verification");
  if (tierForPriceId(prices, priceId) !== tier) return { ok: false, held: "price paid is not the price of the tier claimed" };
  const subscriptionRef = typeof s.subscription === "string" && /^sub_[A-Za-z0-9]+$/.test(s.subscription) ? s.subscription : null;
  const customerRef = typeof s.customer === "string" && /^cus_[A-Za-z0-9]+$/.test(s.customer) ? s.customer : null;
  if (!subscriptionRef) return { ok: false, held: "session carries no subscription" };
  return {
    ok: true,
    facts: { sessionRef: s.id, subject: tenantId ? "tenant" : "checkout", referenceId: tenantId || checkoutId,
             tier, trial, email: payer, customerRef, subscriptionRef }
  };
}
