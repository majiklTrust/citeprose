// =================================================================
// Checkout link construction (2.4.26). The Payment Links surface
// of the Stripe provider, extracted from the billing route so the
// route stays provider-blind and this logic stays pure and
// verifiable. No SDK, no network: dashboard-created links carried
// in environment, tenant identity appended server-side.
//
// Fail-closed at every step: unknown provider, absent env, or a
// non-https value each yield no link at all.
// =================================================================

import { getPaymentsProviderName } from "./provider.js";

const LINK_ENV_BY_TIER = {
  individual: "STRIPE_PAYMENT_LINK_INDIVIDUAL",
  individual_plus: "STRIPE_PAYMENT_LINK_INDIVIDUAL_PLUS",
  business: "STRIPE_PAYMENT_LINK_BUSINESS",
  business_plus: "STRIPE_PAYMENT_LINK_BUSINESS_PLUS"
};

export function getPaymentLinkBase(tier, env = process.env) {
  const key = LINK_ENV_BY_TIER[tier];
  if (!key) return null;
  const raw = env[key];
  if (!raw || typeof raw !== "string" || !raw.startsWith("https://")) return null;
  return raw;
}

export function buildCheckoutUrl(base, tenantId, email) {
  if (!base || !tenantId) return null;
  let url = base + (base.includes("?") ? "&" : "?")
    + "client_reference_id=" + encodeURIComponent(tenantId);
  if (email) url += "&prefilled_email=" + encodeURIComponent(email);
  return url;
}

export function getCheckoutLinksForTenant(tenantId, email, tiers, env = process.env, providerName = getPaymentsProviderName()) {
  if (providerName !== "stripe") return null;
  const links = {};
  for (const tier of tiers || []) {
    const base = getPaymentLinkBase(tier, env);
    if (!base) continue;
    const url = buildCheckoutUrl(base, tenantId, email);
    if (url) links[tier] = url;
  }
  return Object.keys(links).length > 0 ? links : null;
}
