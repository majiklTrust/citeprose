// =================================================================
// Local payments provider (2.3.3): the development and test
// realization of the seam, and the pre-Stripe driving surface.
// Webhooks are HMAC-SHA256 signed over the RAW body with
// PAYMENTS_LOCAL_WEBHOOK_SECRET; verification is fail-closed
// (no secret configured means every webhook is refused) and
// constant-time.
// =================================================================

import crypto from "node:crypto";
import { EVENT_TYPES } from "../provider.js";
import { platformLog } from "../../services/platform-log.js";

// 4.25111.58: same refusal record as the Stripe provider; the null
// return contract is unchanged.
function refuse(reason, headers) {
  platformLog("warn", "payment_webhook_rejected", {
    provider: "local", reason,
    hasSignatureHeader: !!(headers && headers["x-payments-signature"])
  });
  return null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export const localProvider = {
  name: "local",

  // (headers, rawBody Buffer) -> normalized event | null
  parseWebhook(headers, rawBody) {
    const secret = process.env.PAYMENTS_LOCAL_WEBHOOK_SECRET;
    if (!secret) return refuse("PAYMENTS_LOCAL_WEBHOOK_SECRET is not set", headers);
    const given = headers["x-payments-signature"];
    if (!given || !Buffer.isBuffer(rawBody)) return refuse("signature header or raw body missing", headers);
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!safeEqual(given, expected)) return refuse("signature mismatch", headers);
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch { return refuse("signed body is not JSON", headers); }
    if (!body || typeof body !== "object") return refuse("signed body is not an object", headers);
    if (!EVENT_TYPES.includes(body.type)) return refuse(`unknown event type ${String(body.type).slice(0, 40)}`, headers);
    if (typeof body.tenantId !== "string" || !/^[0-9a-f-]{36}$/.test(body.tenantId)) return refuse("tenantId missing or malformed", headers);
    return {
      type: body.type,
      tenantId: body.tenantId,
      tier: typeof body.tier === "string" ? body.tier : null,
      trial: body.trial === true,
      providerEventRef: typeof body.ref === "string" ? `local:${body.ref}` : null,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : null
    };
  }
};
