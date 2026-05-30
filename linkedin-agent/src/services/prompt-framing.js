// ═══════════════════════════════════════════════════════════════
// Prompt Framing — Untrusted Content Boundaries
// ═══════════════════════════════════════════════════════════════
//
// Wraps external content (RSS articles, research briefs) with
// boundary markers retrieved from the encrypted prompt vault.
// The markers instruct the AI to treat enclosed content as DATA,
// not as INSTRUCTIONS — defending against prompt injection via
// poisoned RSS articles.
//
// Called by content-generator.js when building the user prompt.
// ═══════════════════════════════════════════════════════════════

import { getPrompt } from "./prompt-vault.js";
import { platformLog } from "./platform-log.js";

/**
 * Wrap untrusted external content with boundary markers
 * retrieved from the encrypted prompt vault.
 *
 * @param {string} content — Raw external content (RSS article text, research brief)
 * @returns {Promise<string>} Content wrapped with untrusted boundary markers
 */
export async function frameUntrustedContent(content) {
  let prefix = await getPrompt("untrusted_content_prefix");
  let suffix = await getPrompt("untrusted_content_suffix");

  if (!prefix || !suffix) {
    platformLog("error", "prompt_vault_miss", { key: "untrusted_content_prefix/suffix" });
    throw new Error("Untrusted content framing prompts not configured");
  }

  const body = (!content || typeof content !== "string") ? "(empty)" : content;
  const framed = prefix + "\n" + body + "\n" + suffix;

  prefix = null;
  suffix = null;

  return framed;
}
