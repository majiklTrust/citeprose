// ═══════════════════════════════════════════════════════════════
// src/services/image-budget.js - per-cycle render spend gate
// ═══════════════════════════════════════════════════════════════
// The policy layer the render orchestrator clears before spending.
// render() accepts a gate function via deps.budgetGate; this module
// builds that gate. The seam knows nothing about how a budget is
// computed, only that it must clear one, so billing policy lives
// here and the seam stays decoupled.
//
// The gate is fail-closed at every turn:
//   - budget unset or zero cents  -> BUDGET_NOT_SET (feature off)
//   - spent + this estimate > cap -> BUDGET_EXCEEDED
//   - a non-finite estimate is treated as zero, never as "free"
//
// The cap is agent_state.image_render_budget_cents (integer cents,
// owner-set, default 0). The cycle window is the tenant's current
// subscription period_start; with no subscription row it falls back
// to a rolling window (PAYMENTS_CYCLE_DAYS, default 30). Spend is
// the per-image charge in that window, RLS-scoped to the tenant:
// the reconciled actual cost when known, else the pre-spend the gate
// charged (2.5.21: a zero actual never counts as free spend), summed
// the tenant. All DB reads use the ambient tenant client, so the
// gate MUST run inside withTenant (the route guarantees that).
// ═══════════════════════════════════════════════════════════════

import { imageError, IMAGE_ERROR_CODES } from "../image/errors.js";
// DB modules are imported lazily inside the default resolvers so this
// module loads without a database and unit tests inject fakes.

const CENTS_PER_USD = 100;
const DEFAULT_CYCLE_DAYS = 30;

function round6(n) { return Math.round(n * 1e6) / 1e6; }

async function requireClient() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) {
    throw imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, "Budget check requires tenant context (call inside withTenant)");
  }
  return c;
}

// Fail-closed read of the cap: any non-integer or negative value
// resolves to 0, which disables generation rather than opening it.
async function defaultGetBudgetCents() {
  const { getAgentState } = await import("./database.js");
  const raw = await getAgentState("image_render_budget_cents");
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function cycleDays(env) {
  const raw = env && typeof env.PAYMENTS_CYCLE_DAYS === "string" ? env.PAYMENTS_CYCLE_DAYS.trim() : "";
  if (/^[0-9]+$/.test(raw)) {
    const v = parseInt(raw, 10);
    if (v > 0) return v;
  }
  return DEFAULT_CYCLE_DAYS;
}

// Sum of this cycle's render spend, RLS-scoped to the tenant.
async function defaultGetCycleSpendUsd(env = process.env) {
  const c = await requireClient();
  const sub = await c.query("SELECT period_start FROM subscriptions WHERE tenant_id = current_tenant_id()");
  const start = sub.rows.length > 0 ? sub.rows[0].period_start : null;
  let r;
  if (start) {
    r = await c.query("SELECT COALESCE(SUM(COALESCE(NULLIF(cost_estimate_usd, 0), pre_spend_estimate_usd, 0)), 0) AS spent FROM images WHERE created_at >= $1", [start]);
  } else {
    // No subscription row: rolling fallback window.
    r = await c.query(
      "SELECT COALESCE(SUM(COALESCE(NULLIF(cost_estimate_usd, 0), pre_spend_estimate_usd, 0)), 0) AS spent FROM images WHERE created_at >= now() - make_interval(days => $1)",
      [cycleDays(env)]
    );
  }
  const spent = Number(r.rows[0].spent);
  return Number.isFinite(spent) && spent >= 0 ? spent : 0;
}

function resolveDeps(deps = {}) {
  return {
    env: deps.env || process.env,
    getBudgetCents: deps.getBudgetCents || defaultGetBudgetCents,
    getCycleSpendUsd: deps.getCycleSpendUsd || ((env) => defaultGetCycleSpendUsd(env))
  };
}

// Read-only status for the admin page and the Studio (how much is
// left this cycle). Never throws for a zero budget; reports enabled=false.
export async function getBudgetStatus(deps = {}) {
  const d = resolveDeps(deps);
  const cents = await d.getBudgetCents();
  const budgetUsd = cents / CENTS_PER_USD;
  const spentUsd = budgetUsd > 0 ? await d.getCycleSpendUsd(d.env) : 0;
  return {
    enabled: budgetUsd > 0,
    budgetCents: cents,
    budgetUsd: round6(budgetUsd),
    spentUsd: round6(spentUsd),
    remainingUsd: round6(Math.max(0, budgetUsd - spentUsd))
  };
}

// Build the gate render() injects. Returns a function that resolves
// with an accounting summary when the render fits, or throws a
// typed denial. It NEVER resolves silently on a missing budget.
export function makeBudgetGate(deps = {}) {
  const d = resolveDeps(deps);
  return async function budgetGate(estimatedCostUsd) {
    const estimate = Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0 ? estimatedCostUsd : 0;
    const cents = await d.getBudgetCents();
    const budgetUsd = cents / CENTS_PER_USD;
    if (!(budgetUsd > 0)) {
      throw imageError(IMAGE_ERROR_CODES.BUDGET_NOT_SET,
        "Image render budget is not set for this workspace; generation is disabled until an owner sets a budget");
    }
    const spentUsd = await d.getCycleSpendUsd(d.env);
    // Epsilon guards floating-point equality at the exact boundary.
    if (spentUsd + estimate > budgetUsd + 1e-9) {
      throw imageError(IMAGE_ERROR_CODES.BUDGET_EXCEEDED,
        "This render would exceed the workspace image budget for the current cycle",
        { budgetUsd: round6(budgetUsd), spentUsd: round6(spentUsd), estimateUsd: round6(estimate) });
    }
    return Object.freeze({
      budgetUsd: round6(budgetUsd),
      spentUsd: round6(spentUsd),
      estimateUsd: round6(estimate),
      remainingUsd: round6(budgetUsd - spentUsd - estimate)
    });
  };
}

// ── Owner budget input validation ──────────────────────────────
// Convert an owner-supplied DOLLAR figure to integer CENTS for
// storage in agent_state.image_render_budget_cents, or return null
// if the input is not an acceptable, non-negative, in-range amount.
// Zero is valid and means "disabled" (the gate fails closed on a
// zero cap). Kept in the budget domain module, beside the gate that
// consumes the stored cents, so validation and consumption cannot
// drift apart. Pure: no I/O, no tenant context.
export const MAX_BUDGET_DOLLARS = 1000000; // fat-finger / integer-column guard

export function dollarsToCents(dollars) {
  if (typeof dollars !== "number" && typeof dollars !== "string") return null;
  if (typeof dollars === "string" && dollars.trim() === "") return null; // no silent 0 from empty
  const n = typeof dollars === "number" ? dollars : Number(dollars.trim());
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > MAX_BUDGET_DOLLARS) return null;
  const cents = Math.round(n * 100);
  return Number.isInteger(cents) && cents >= 0 ? cents : null;
}
