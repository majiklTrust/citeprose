// =================================================================
// Checkout link construction (2.4.26). Extracted from the billing
// route so the route stays provider-blind and this logic stays pure
// and verifiable. No SDK, no network.
//
// 4.25111.82: Payment Links are retired. A Payment Link carried the
// tenant (or purchase) reference as a query parameter the browser
// wrote, so the official payment page could be pointed at any
// reference by anyone. The links the billing page and the public
// pricing page show now lead to the checkout door (/checkout/<tier>),
// where the server creates a Checkout Session bound to the caller's
// own workspace or purchase (payments/stripe-checkout.js). The
// STRIPE_PAYMENT_LINK_<TIER> variables are no longer read.
//
// Fail-closed at every step: a provider other than stripe, or no
// secret key to create sessions with, yields no link at all.
// =================================================================

import { getPaymentsProviderName } from "./provider.js";
import { TIERS } from "../config/entitlements.js";
import { isCheckoutAvailable } from "./stripe-checkout.js";

// The door path for a tier. SECURITY: the TIERS membership gate is
// load-bearing; never build a path from caller input.
export function getCheckoutDoorPath(tier) {
  if (typeof tier !== "string" || !TIERS.includes(tier)) return null;
  return "/checkout/" + tier;
}

// 2.5.95: the Stripe no-code Customer Portal login link. Same
// contract as before: a static env-configured URL, no SDK, no
// outbound calls. Absent or non-https resolves null and the page
// hides the affordance (fail closed).
export function getCustomerPortalUrl(env = process.env) {
  const raw = env.STRIPE_CUSTOMER_PORTAL_URL;
  const url = typeof raw === "string" ? raw.trim() : "";
  return url.startsWith("https://") ? url : null;
}

export function getCheckoutLinksForTenant(tenantId, email, tiers, env = process.env, providerName = getPaymentsProviderName()) {
  if (providerName !== "stripe" || !isCheckoutAvailable(env)) return null;
  const links = {};
  for (const tier of tiers || []) {
    const path = getCheckoutDoorPath(tier);
    if (path) links[tier] = path;
  }
  return Object.keys(links).length > 0 ? links : null;
}
