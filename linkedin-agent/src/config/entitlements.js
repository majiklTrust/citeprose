// =================================================================
// Entitlement configuration: Payments Step 1 (2.3.1.1)
// =================================================================
// The tier-to-capability matrix. Core loop capabilities (topics,
// feeds, posting, own analytics) are implicit in ANY non-denied
// subscription state; only the named capabilities below are
// tier-gated. ads_manager and image_studio are pre-declared so
// those features are born entitlement-gated when they ship.
// =================================================================

export const TIERS = ["individual", "business", "business_plus", "business_premium"];

const MATRIX = {
  individual: [],
  business: ["organization_manager"],
  // business_plus (2.5.20): organization_manager is ruled; whether
  // ads_manager or image_studio join it is an OPEN RULING. Under-
  // grant until ruled: never mint entitlement from a guess.
  business_plus: ["organization_manager"],
  business_premium: ["organization_manager", "ads_manager", "image_studio"]
};

export function tierCapabilities(tier) {
  // Scalar strings only: an array like ['business'] coerces to a
  // valid object key in JS, which must never mint entitlement.
  if (typeof tier !== "string") return [];
  return MATRIX[tier] ? [...MATRIX[tier]] : [];
}

export function isKnownCapability(capability) {
  if (typeof capability !== "string") return false;
  return ["organization_manager", "ads_manager", "image_studio"].includes(capability);
}

// Grace period (days) before the first 30-day cycle. Applies to
// individual and business only, per ruling; business_premium
// starts active.
export function getTrialDays() {
  const v = Number(process.env.PAYMENTS_TRIAL_DAYS);
  return Number.isInteger(v) && v >= 0 ? v : 5;
}

export function getCycleDays() {
  const v = Number(process.env.PAYMENTS_CYCLE_DAYS);
  return Number.isInteger(v) && v > 0 ? v : 30;
}

export function trialEligible(tier) {
  return tier === "individual" || tier === "business";
}
