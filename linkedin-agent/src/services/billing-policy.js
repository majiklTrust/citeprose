// =================================================================
// Billing policy (2.4.26). The named answers to "who may do what"
// on the billing surface, extracted from route conditionals so
// each rule has one home, one name, and a pure signature.
// =================================================================

// A fresh checkout creates a NEW processor subscription, so it is
// legitimate only where none is live: no subscription at all, or a
// cancelled one. Every live state (trialing, active, past_due,
// suspended) must never see a path to a second concurrent
// subscription: the app would refuse the duplicate event, but the
// processor would still be billing it.
export function getFreshCheckoutAllowed(subscriptionState) {
  return subscriptionState === null || subscriptionState === undefined
    || subscriptionState === "none" || subscriptionState === "cancelled";
}

// Under a live processor, the pending_tier mechanic would flip the
// app's tier while the processor keeps invoicing the original
// price: entitlement and revenue diverge. Self-serve tier change
// is therefore local-provider only until portal or checkout-based
// upgrades exist. Comp subscriptions are platform-managed and
// never self-serve regardless of provider.
export function getTierChangeEnabled(providerName, isComp) {
  if (isComp === true) return false;
  return providerName !== "stripe";
}

// Reactivation is a fresh checkout constrained to the tenant's
// existing tier: suspension must not become a self-serve upgrade.
export function getReactivationTier(subscription) {
  if (!subscription || subscription.state !== "suspended") return null;
  return subscription.tier || null;
}
