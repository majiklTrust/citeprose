// ═══════════════════════════════════════════════════════════════
// src/config/dashboard-copy.js
// End-user copy as package configuration (4.25111.55, renamed .56)
// ═══════════════════════════════════════════════════════════════
//
// Every string the SERVER emits that an end user can read (the text
// behind a dashboard alert, a card line, the connection tile) is a
// package configuration value, not a literal in code. Values live in
// package.json under config.dashboard.copy, one flat map of key to
// text. The same map is injected into the dashboard bundle at build
// time (scripts/build-pages.mjs, placeholder "{{DASHBOARD_COPY_JSON}}"),
// so the operator edits ONE place and rebuilds.
//
// 4.25111.56: the config path is config.dashboard.copy (a nested
// object). In npm's own notation that path reads "dashboard.copy":
// npm pkg get config.dashboard.copy, npm config overrides, and the
// npm_package_config_* env flattening all treat "." as a path
// separator, so a nested object is the form every npm tool expects.
// A literal key containing a dot ("dashboard.copy") is legal JSON
// and Node would read it with bracket access, but those same tools
// would split it; that form was deliberately not used.
//
// Contract:
//   dashboardCopy(key, vars)    the text for `key` with {name} tokens
//                               replaced from `vars`; a key with no
//                               configured value renders as
//                               "[dashboard.copy:key]" so the omission
//                               is visible on the surface, never a
//                               crash.
//   SERVER_DASHBOARD_COPY_KEYS  every key the server reads. The build
//                               (npm run pages) refuses to build when
//                               any of these, or any
//                               DASHBOARD_COPY.<key> the dashboard
//                               uses, is absent from package.json, so
//                               a missing value is caught at build
//                               time rather than on a screen.
//
// package.json is read once, on first use, relative to this module
// (never the process cwd), which keeps the lookup correct under any
// launcher. The read is guarded: a broken package.json yields the
// "[copy:key]" fallback plus one warning per key, not a crash.
//
// Why config and not a database row or an env var: this is static
// product wording that changes with a release, reviewed by the owner,
// shipped by the build; it belongs beside appname and cssversion.
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";

// The logger is imported lazily so that importing this module (the
// build does, to read SERVER_DASHBOARD_COPY_KEYS) pulls in no service
// code.
async function warn(level, event, detail) {
  try {
    const { platformLog } = await import("../services/platform-log.js");
    platformLog(level, event, detail);
  } catch { /* the fallback text is already on the surface */ }
}

export const SERVER_DASHBOARD_COPY_KEYS = Object.freeze([
  // scheduler.approvePost pre-flight (checkPublishCredentials)
  "linkedinNotConnected",         // {target} is one of the two labels below
  "linkedinTargetPersonal",
  "linkedinTargetOrganization",
  "linkedinOrgRequiresRest",      // organization target under text-posting mode
  // scheduler.executePostInner success guard
  "publishNoSuccessConfirmation",
  // api.js /api/status connection tile reason (empty string hides the line)
  "linkedinStatusNoToken",
  "linkedinStatusNotConfirmed"    // {reason} is the live check's own words
]);

let table = null;
const warned = new Set();

function load() {
  if (table) return table;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const cfg = pkg && pkg.config && pkg.config.dashboard && pkg.config.dashboard.copy;
    table = cfg && typeof cfg === "object" ? cfg : {};
  } catch (err) {
    warn("error", "dashboard_copy_config_unreadable", { error: err.message });
    table = {};
  }
  return table;
}

// Text for `key`. {name} tokens are replaced from `vars`; a token with
// no value is left as written so a typo in the config is visible.
export function dashboardCopy(key, vars = {}) {
  const raw = load()[key];
  let text;
  if (typeof raw === "string") {
    text = raw;
  } else {
    if (!warned.has(key)) {
      warned.add(key);
      warn("warn", "dashboard_copy_key_missing", { key });
    }
    text = `[dashboard.copy:${key}]`;
  }
  return text.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
}

// Keys from `keys` with no string value configured. Used by the build.
export function missingDashboardCopyKeys(keys = SERVER_DASHBOARD_COPY_KEYS) {
  const t = load();
  return keys.filter((k) => typeof t[k] !== "string");
}
