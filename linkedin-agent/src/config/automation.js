// ═══════════════════════════════════════════════════════════════
// src/config/automation.js: automation configuration from the
// environment
// ═══════════════════════════════════════════════════════════════
// 4.25111.66 (first cut 4.25111.64). Pure and dependency-free: this
// module imports nothing, reads its variables every time it is
// asked (never at import, never cached), and is the ONLY place in
// the application that names them. The automation interpreter
// (src/automation/automation-mode.js) is its only consumer; routes,
// loops and the dashboard see the effect through the interpreter's
// answers, not the variables.
//
// ── ENABLE_AUTO_POST ─────────────────────────────────────────
// Decides whether the auto-post automation state (the agent
// publishing on its own after the review window) is offered at all
// on this server:
//
//   unset or blank   -> off (the default)
//   yes | true       -> on
//   no  | false      -> off
//   anything else    -> off, and reported as invalid so the caller
//                       can log it
//
// The four words are matched in any letter case with surrounding
// whitespace ignored, because a shell, a .env loader and a container
// runtime disagree about both. Nothing else counts: not 1, not on,
// not y, not a look-alike letter from another script. The safe
// direction is always "not offered": a value that is not one of the
// four words leaves automated publishing off, never on.
// ═══════════════════════════════════════════════════════════════

export const ENABLE_AUTO_POST_ENV = "ENABLE_AUTO_POST";

const ENABLING = Object.freeze(["yes", "true"]);
const DISABLING = Object.freeze(["no", "false"]);

// Sanitized, capped echo of a value that was not one of the four
// words, safe to put in a log line: control characters replaced,
// length bounded.
function echo(value) {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 60).trim();
}

// Interprets one value as read from the environment.
//   { enabled: boolean, source: "env" | "default", valid: boolean, raw }
// raw is the sanitized echo of the value when one was given.
export function resolveAutoPostFlag(envValue) {
  if (envValue === undefined) return { enabled: false, source: "default", valid: true, raw: undefined };
  if (typeof envValue !== "string") {
    return { enabled: false, source: "env", valid: false, raw: echo(typeof envValue === "symbol" ? "symbol" : envValue) };
  }
  const word = envValue.trim().toLowerCase();
  if (word === "") return { enabled: false, source: "default", valid: true, raw: "" };
  if (ENABLING.includes(word)) return { enabled: true, source: "env", valid: true, raw: word };
  if (DISABLING.includes(word)) return { enabled: false, source: "env", valid: true, raw: word };
  return { enabled: false, source: "env", valid: false, raw: echo(envValue) };
}

// The flag as it stands right now, from the given environment (the
// process environment by default). Read at call time on purpose: an
// operator who changes the variable and restarts must see the
// change, and a suite that flips it must too.
export function currentAutoPostFlag(env = process.env) {
  const value = env && typeof env === "object" ? env[ENABLE_AUTO_POST_ENV] : undefined;
  return resolveAutoPostFlag(value);
}

export function isAutoPostEnabled(env = process.env) {
  return currentAutoPostFlag(env).enabled;
}
