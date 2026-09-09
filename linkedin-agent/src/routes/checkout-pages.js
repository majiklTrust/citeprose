// ═══════════════════════════════════════════════════════════════
// checkout-pages.js: from Purchase on the public page to Stripe and back
// ═══════════════════════════════════════════════════════════════
// 4.25111.78. Two browser routes, no JSON API.
//
//   GET /checkout/:tier    the door. Signed out: to Auth0 sign up with
//                          this door as the return target. Signed in
//                          and already a member of a workspace: to
//                          /app/billing, where that workspace's own
//                          checkout lives. Otherwise: mint or reuse the
//                          buyer's self-registration, open (or re-tier)
//                          the purchase row whose id is the
//                          client_reference_id, log checkout_started,
//                          and 302 to the Payment Link with the email
//                          filled in. The Payment Link base and the id
//                          are joined here and nowhere the browser can
//                          read before this redirect.
//   GET /checkout/return   the fixed after-payment address every
//                          Payment Link points at. It trusts nothing in
//                          the URL: it looks the buyer up by login,
//                          finds the open purchase, and sends them to
//                          the register page with a live token (or to
//                          /app/billing when the workspace exists).
//                          "Paid" is decided by the processor's signed
//                          message alone, never by arriving here.
//
// Precautions for a public door: every answer is no-store; a
// per-address ceiling sits in front; the tier is checked against
// TIERS before anything is read; nothing from the request is echoed
// into a page; email verification is not required (owner's ruling:
// Auth0 verification is optional), so a buyer proceeds to pay with
// an unverified address and verifies later, or never.
// ═══════════════════════════════════════════════════════════════
import express from "express";
import { TIERS } from "../config/entitlements.js";
import { readSession } from "../auth/session.js";
import { getPaymentLinkBase, buildCheckoutUrl } from "../payments/checkout-links.js";
import { getPaymentsProviderName } from "../payments/provider.js";
import { platformLog } from "../services/platform-log.js";
import { createRequestLimiter } from "../services/request-limiter.js";

const PER_ADDRESS_PER_MINUTE = 30;
const REGISTER_PAGE = "/app/register#token=";
const BILLING_PAGE = "/app/billing";
const APP_PAGE = "/app";

function loginUrl(returnTo, signup) {
  return "/auth/login?" + (signup ? "signup=1&" : "") + "returnTo=" + encodeURIComponent(returnTo);
}

function page(res, status, title, text) {
  res.status(status).type("html").send(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
    `<style>body{margin:0;background:#f7f5f0;color:#0f0f0f;font-family:'DM Sans',sans-serif;font-weight:300;line-height:1.55}main{max-width:52rem;margin:0 auto;padding:2.5rem 1.5rem}h1{font-family:'Playfair Display',serif;font-weight:600;font-size:1.6rem;margin:0 0 .5rem}a{color:#1a3a5c}</style></head>` +
    `<body><main><h1>${title}</h1><p>${text}</p><p><a href="/pricing.html">Back to plans</a></p></main></body></html>`
  );
}

async function membership(sub) {
  const { findTenantByAuthIdentity } = await import("../tenant/platform-db.js");
  return findTenantByAuthIdentity("auth0", sub);
}

export default function createCheckoutRoutes() {
  const router = express.Router();
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(createRequestLimiter({ limit: PER_ADDRESS_PER_MINUTE, name: "checkout" }));

  // ── Back from Stripe ─────────────────────────────────────────
  router.get("/return", async (req, res) => {
    try {
      const session = readSession(req);
      if (!session) return res.redirect(loginUrl("/checkout/return", false));
      const sub = session.user.sub;
      if (await membership(sub)) return res.redirect(BILLING_PAGE);
      const store = await import("../tenant/checkout-store.js");
      const open = await store.findOpenForLogin(sub);
      if (!open) return res.redirect(APP_PAGE);
      let token = await store.liveTokenForRegistration(open.registration_id);
      if (!token) {
        // The registration aged out between paying and coming back
        // (five days by default): mint a fresh one for the same login;
        // the register page's completion finds the paid purchase by
        // login as well as by registration.
        const { attemptSelfRegistration } = await import("../tenant/self-registration-store.js");
        const v = await attemptSelfRegistration(open.email, sub);
        token = v && v.token ? v.token : null;
      }
      if (!token) return res.redirect(APP_PAGE);
      platformLog("info", "checkout_returned", { checkoutId: open.id, status: open.status, sub });
      return res.redirect(REGISTER_PAGE + encodeURIComponent(token));
    } catch (err) {
      platformLog("error", "checkout_return_failed", { error: err && err.message });
      return page(res, 500, "Something went wrong", "We could not find your purchase right now. Sign in and open your dashboard; your workspace setup is waiting there.");
    }
  });

  // ── The door ─────────────────────────────────────────────────
  router.get("/:tier", async (req, res) => {
    const tier = req.params.tier;
    if (typeof tier !== "string" || !TIERS.includes(tier)) {
      return page(res, 404, "Unknown plan", "That plan does not exist. Choose one from the pricing page.");
    }
    try {
      const session = readSession(req);
      if (!session) return res.redirect(loginUrl("/checkout/" + tier, true));
      const sub = session.user.sub;
      const email = typeof session.user.email === "string" ? session.user.email.trim() : "";
      if (await membership(sub)) return res.redirect(BILLING_PAGE);
      if (!email || !email.includes("@")) {
        return page(res, 403, "No email on this login", "Your login carries no email address, so a workspace cannot be set up for it.");
      }
      if (getPaymentsProviderName() !== "stripe" || getPaymentLinkBase(tier) === null) {
        return page(res, 409, "Purchase is not available", "This plan cannot be purchased online on this server. Contact us to arrange it.");
      }
      const { attemptSelfRegistration, SELF_REG_OUTCOME } = await import("../tenant/self-registration-store.js");
      const verdict = await attemptSelfRegistration(email, sub);
      if (!verdict || !verdict.token) {
        const o = verdict && verdict.outcome;
        platformLog("info", "checkout_refused", { sub, tier, reason: o || "no_token" });
        if (o === SELF_REG_OUTCOME.ALREADY_MEMBER) return res.redirect(BILLING_PAGE);
        if (o === SELF_REG_OUTCOME.INVITE_PENDING || o === SELF_REG_OUTCOME.REGISTRATION_EXISTS) return res.redirect(APP_PAGE);
        if (o === SELF_REG_OUTCOME.RATE_LIMITED) return page(res, 429, "Too many attempts", "This login has reached its workspace setup limit. Contact support.");
        res.set("Retry-After", "2");
        return page(res, 503, "One moment", "Setup is being prepared. Go back and press Purchase again.");
      }
      const { validateRegistrationToken } = await import("../tenant/platform-db.js");
      const reg = await validateRegistrationToken(verdict.token);
      if (!reg) {
        res.set("Retry-After", "2");
        return page(res, 503, "One moment", "Setup is being prepared. Go back and press Purchase again.");
      }
      const store = await import("../tenant/checkout-store.js");
      const row = await store.openCheckout({ registrationId: reg.id, authSub: sub, email, tier });
      if (row.status === "paid") {
        // Already paid and not yet set up: the register page is the
        // next step, not a second payment.
        const token = await store.liveTokenForRegistration(row.registration_id);
        return res.redirect(token ? REGISTER_PAGE + encodeURIComponent(token) : APP_PAGE);
      }
      const url = buildCheckoutUrl(getPaymentLinkBase(tier), row.id, email);
      platformLog("info", "checkout_started", { checkoutId: row.id, registrationId: reg.id, tier, sub, from: "pricing" });
      return res.redirect(302, url);
    } catch (err) {
      platformLog("error", "checkout_door_failed", { tier, error: err && err.message });
      return page(res, 500, "Something went wrong", "We could not start your purchase right now. Please try again in a moment.");
    }
  });

  return router;
}
