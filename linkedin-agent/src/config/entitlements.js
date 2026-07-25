// =================================================================
// Entitlement configuration: Payments Step 1 (2.3.1.1)
// =================================================================
// The tier-to-capability matrix. Core loop capabilities (topics,
// feeds, posting, own analytics) are implicit in ANY non-denied
// subscription state; only the named capabilities below are
// tier-gated. ads_manager and image_studio are pre-declared so
// those features are born entitlement-gated when they ship.
// =================================================================

export const TIERS = ["individual", "individual_plus", "business", "business_plus"];

const MATRIX = {
  // 2.4.40 restructure: two product lines, priced per ruling.
  // individual line: core, then Image Studio at plus.
  // business line: organization_manager, then Advocacy + Image
  // Studio at plus. business_premium is RETIRED (migration:
  // existing rows move to business_plus).
  // image_studio also unlocks attaching an AI generated image to
  // a post wherever that affordance gates on the capability.
  individual: [],
  individual_plus: ["image_studio"],
  business: ["organization_manager"],
  business_plus: ["organization_manager", "employee_advocacy", "image_studio"]
};

export function tierCapabilities(tier) {
  // Scalar strings only: an array like ['business'] coerces to a
  // valid object key in JS, which must never mint entitlement.
  if (typeof tier !== "string") return [];
  return MATRIX[tier] ? [...MATRIX[tier]] : [];
}

export function isKnownCapability(capability) {
  if (typeof capability !== "string") return false;
  return ["organization_manager", "ads_manager", "image_studio", "employee_advocacy"].includes(capability);
}

// Grace period (days) before the first 30-day cycle. The
// trial-eligible set is ruled; the condition in trialEligible
// below is its single source of truth.
export function getTrialDays() {
  const v = Number(process.env.PAYMENTS_TRIAL_DAYS);
  return Number.isInteger(v) && v >= 0 ? v : 5;
}

export function getCycleDays() {
  const v = Number(process.env.PAYMENTS_CYCLE_DAYS);
  return Number.isInteger(v) && v > 0 ? v : 30;
}

export function trialEligible(tier) {
  // Under-grant until ruled otherwise: tiers outside this
  // condition are ineligible by default, never by omission.
  return tier === "individual" || tier === "business";
}
