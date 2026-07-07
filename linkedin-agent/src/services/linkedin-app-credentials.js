// =================================================================
// src/services/linkedin-app-credentials.js, per-tenant app config
// =================================================================
// TD-1 (Phase 2 Step 0): the LinkedIn APP credentials move from
// global environment to per-tenant storage. Resolution, highest
// layer first:
//   1. tenant row      client id and secret in the credentials
//                      table (tenant-HKDF encrypted); redirect URI
//                      in agent_state (plaintext, per requirement)
//   2. platform env    LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET
//                      (platform-encrypted, decrypted on read) and
//                      LINKEDIN_REDIRECT_URI (plaintext, read raw)
// A tenant with no rows behaves exactly as before (env), so the
// current single-tenant deployment is unchanged until a tenant
// stores its own values.
//
// Zero Trust notes (TD-3 discipline applied here too): secrets are
// decrypted only at call time, never cached across tenants, never
// logged; outside tenant context the tenant layer is skipped, not
// errored, so resolution degrades to the platform default (the
// getPublishTarget pattern).
//
// Import discipline: DB-touching modules load lazily so this
// module imports with no database environment and the resolution
// core is testable with injected deps.
// =================================================================

function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// -- Client id ---------------------------------------------------
export async function getTenantLinkedInClientId(deps = {}) {
  try {
    let read = deps.getTenantRow;
    if (!read) {
      const cs = await import("../tenant/credential-store.js");
      read = cs.getLinkedInAppClientId;
    }
    const v = nonEmpty(await read());
    if (v) return v;
  } catch { /* outside tenant context or no row: fall through */ }

  const cipher = nonEmpty(deps.envCipher !== undefined ? deps.envCipher : process.env.LINKEDIN_CLIENT_ID);
  if (!cipher) {
    throw new Error("LinkedIn client id is not configured (no tenant row and LINKEDIN_CLIENT_ID is not set)");
  }
  const decrypt = deps.decrypt || (await import("./platform-secret.js")).decryptPlatformSecret;
  return decrypt(cipher);
}

// -- Client secret -----------------------------------------------
export async function getTenantLinkedInClientSecret(deps = {}) {
  try {
    let read = deps.getTenantRow;
    if (!read) {
      const cs = await import("../tenant/credential-store.js");
      read = cs.getLinkedInAppClientSecret;
    }
    const v = nonEmpty(await read());
    if (v) return v;
  } catch { /* outside tenant context or no row: fall through */ }

  const cipher = nonEmpty(deps.envCipher !== undefined ? deps.envCipher : process.env.LINKEDIN_CLIENT_SECRET);
  if (!cipher) {
    throw new Error("LinkedIn client secret is not configured (no tenant row and LINKEDIN_CLIENT_SECRET is not set)");
  }
  const decrypt = deps.decrypt || (await import("./platform-secret.js")).decryptPlatformSecret;
  return decrypt(cipher);
}

// -- Redirect URI (plaintext by requirement) ----------------------
// Tenant layer: agent_state key "linkedin_redirect_uri". Env layer:
// LINKEDIN_REDIRECT_URI read RAW (never decrypted), preserving the
// pre-Step-0 behavior. May return undefined when neither is set;
// LinkedIn then rejects the auth request loudly, which is the
// existing failure mode.
export async function getTenantLinkedInRedirectUri(deps = {}) {
  try {
    let getState = deps.getState;
    if (!getState) {
      const db = await import("./database.js");
      getState = db.getAgentState;
    }
    const v = nonEmpty(await getState("linkedin_redirect_uri"));
    if (v) return v;
  } catch { /* outside tenant context: fall through */ }
  const env = nonEmpty(deps.envValue !== undefined ? deps.envValue : process.env.LINKEDIN_REDIRECT_URI);
  return env || undefined;
}

// A valid redirect URI for the tenant layer: parses as a URL with
// an http or https scheme and carries no embedded credentials.
export function isValidRedirectUri(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const trimmed = value.trim();
  // The WHATWG URL parser silently STRIPS embedded tab/newline, so
  // a value like "https://\nhost/cb" parses clean while the stored
  // plaintext still carries the control character. Refuse any
  // control character or interior whitespace outright.
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return false;
  let parsed;
  try { parsed = new URL(trimmed); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

// -- Presence probes for the status endpoint ----------------------
export async function getTenantAppConfigStatus(deps = {}) {
  let pair = false;
  let redirectUri = null;
  try {
    let has = deps.hasPair;
    if (!has) {
      const cs = await import("../tenant/credential-store.js");
      has = cs.hasLinkedInAppCredentials;
    }
    pair = await has();
  } catch { pair = false; }
  try {
    let getState = deps.getState;
    if (!getState) {
      const db = await import("./database.js");
      getState = db.getAgentState;
    }
    redirectUri = nonEmpty(await getState("linkedin_redirect_uri"));
  } catch { redirectUri = null; }
  return { tenantPairConfigured: pair, tenantRedirectUri: redirectUri };
}

// -- Atomic setter (runs INSIDE withTenant) -----------------------
// Contract mirrors setManualTokens:
//   - clientId and clientSecret are a PAIR: both or neither. A
//     lone half is refused and NOTHING is stored (a mismatched
//     id/secret pair bricks the OAuth flow silently).
//   - redirectUri is independent and optional; a supplied value
//     must pass isValidRedirectUri; an empty string CLEARS the
//     tenant override so resolution falls back to env.
//   - Secret VALUES never reach a log. Lengths and booleans only.
export async function setTenantAppCredentials(input = {}, deps = {}) {
  const d = { ...deps };
  if (!d.store || !d.setState || !d.log) {
    const cs = await import("../tenant/credential-store.js");
    const db = await import("./database.js");
    d.store = d.store || cs.storeCredential;
    d.setState = d.setState || db.setAgentState;
    d.log = d.log || db.logActivity;
  }

  const clientId = nonEmpty(input.clientId);
  const clientSecret = nonEmpty(input.clientSecret);
  const redirectRaw = input.redirectUri;
  const wantsPair = clientId !== null || clientSecret !== null;
  const wantsRedirect = redirectRaw !== undefined;

  if (!wantsPair && !wantsRedirect) {
    return { status: "rejected", reason: "nothing to store: supply clientId+clientSecret, redirectUri, or both" };
  }
  if (wantsPair && (!clientId || !clientSecret)) {
    return { status: "rejected", reason: "clientId and clientSecret are a pair: both are required; nothing was stored" };
  }
  let redirectValue = null;
  let clearRedirect = false;
  if (wantsRedirect) {
    if (typeof redirectRaw === "string" && redirectRaw.trim() === "") {
      clearRedirect = true;
    } else if (isValidRedirectUri(redirectRaw)) {
      redirectValue = String(redirectRaw).trim();
    } else {
      return { status: "rejected", reason: "redirectUri must be an http(s) URL without embedded credentials; nothing was stored" };
    }
  }

  if (wantsPair) {
    await d.store("linkedin_client_id", clientId);
    await d.store("linkedin_client_secret", clientSecret);
  }
  if (wantsRedirect) {
    await d.setState("linkedin_redirect_uri", clearRedirect ? "" : redirectValue);
  }

  await d.log("info", "linkedin_app_credentials_set", {
    pairStored: wantsPair,
    clientIdLength: wantsPair ? clientId.length : 0,
    redirectStored: wantsRedirect && !clearRedirect,
    redirectCleared: clearRedirect
  });

  return {
    status: "stored",
    pairStored: wantsPair,
    redirectStored: wantsRedirect && !clearRedirect,
    redirectCleared: clearRedirect
  };
}
