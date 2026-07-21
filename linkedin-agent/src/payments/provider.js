// =================================================================
// Payments provider seam (2.3.3), LLM-abstraction precedent:
// feature code may NEVER import a processor SDK; only files under
// src/payments/providers/ may. Selection via PAYMENTS_PROVIDER
// (default 'local'); unknown names fail closed at first use.
//
// Normalized event DTO every provider must emit:
//   { type, tenantId, tier?, trial?, providerEventRef?, occurredAt? }
// with type in: checkout_completed | payment_succeeded |
// payment_failed | dunning_exhausted | subscription_cancelled
// =================================================================

export const EVENT_TYPES = [
  "checkout_completed",
  "payment_succeeded",
  "payment_failed",
  "dunning_exhausted",
  "subscription_cancelled"
];

// The single source of the active provider name. Every consumer
// (routes, policy, adapters) resolves through here: no inline env
// parsing anywhere else.
export function getPaymentsProviderName() {
  return (process.env.PAYMENTS_PROVIDER || "local").trim();
}

export async function getPaymentsProvider() {
  const name = getPaymentsProviderName();
  if (name === "local") {
    const { localProvider } = await import("./providers/local.js");
    return localProvider;
  }
  if (name === "stripe") {
    const { stripeProvider } = await import("./providers/stripe.js");
    return stripeProvider;
  }
  throw new Error(`Unknown payments provider: ${name}`);
}
