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
import { TIERS } from "../config/entitlements.js";

// Env names derive from TIERS (2.4.53): STRIPE_PAYMENT_LINK_ plus
// the uppercased tier. No hand-maintained map to drift from the
// tier set. SECURITY: the TIERS membership gate below is load-
// bearing, never derive an env name from caller input, or the
// tier argument becomes an environment-probing primitive.
export function getPaymentLinkBase(tier, env = process.env) {
  if (typeof tier !== "string" || !TIERS.includes(tier)) return null;
  const raw = env["STRIPE_PAYMENT_LINK_" + tier.toUpperCase()];
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

// 2.5.95: the Stripe no-code Customer Portal login link. Same
// contract as the payment links: a static env-configured URL, no
// SDK, no outbound calls. Absent or non-https resolves null and the
// page hides the affordance (fail closed).
export function getCustomerPortalUrl(env = process.env) {
  const raw = env.STRIPE_CUSTOMER_PORTAL_URL;
  const url = typeof raw === "string" ? raw.trim() : "";
  return url.startsWith("https://") ? url : null;
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
