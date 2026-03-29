// ═══════════════════════════════════════════════════════════════
// Output Content Filter — Pre-Publish Security Scan
// ═══════════════════════════════════════════════════════════════
//
// Scans AI-generated content BEFORE publishing to LinkedIn.
// Three scan layers:
//
//   1. scanForSecrets(content)      — API keys, hex secrets, env var leaks
//   2. scanForPromptLeak(content)   — System prompt fragments, instruction repetition
//   3. scanForExfiltration(content) — Base64 blocks, suspicious URLs with data params
//
// runOutputFilter(content) runs all three and returns a combined result.
//
// Called by scheduler.js in executePost() BEFORE publishPost().
// If blocked, the post is rejected and logged — never published.
// ═══════════════════════════════════════════════════════════════

// ── Secret Patterns ──────────────────────────────────────────
// Each pattern has a name for logging and a regex for matching.

const SECRET_PATTERNS = [
  // Anthropic API keys — full pattern
  { name: "anthropic_key", pattern: /sk-ant[\s-]*api\d*[\s-]*[a-zA-Z0-9]{8,}/i },

  // Anthropic API key prefix alone — "sk-ant-api" has no legitimate
  // reason to appear in a LinkedIn post. Catches split keys where
  // the prefix and suffix are separated by natural language.
  { name: "anthropic_key_prefix", pattern: /sk[-\s]*ant[-\s]*api/i },

  // AWS access keys
  { name: "aws_key", pattern: /AKIA[0-9A-Z]{12,}/  },

  // GitHub tokens
  { name: "github_token", pattern: /gh[ps]_[A-Za-z0-9]{20,}/ },

  // Generic sk- keys (Stripe, OpenAI, etc.)
  { name: "generic_sk_key", pattern: /sk-[a-zA-Z]*[\s-]*[a-zA-Z0-9]{16,}/ },

  // Hex strings 64+ chars (SESSION_SECRET, ENCRYPTION_SECRET length)
  // Ignore if broken by non-hex chars — but catch dashed hex too
  { name: "long_hex_secret", pattern: /(?:[0-9a-f]{4}[-]?){16,}/i },

  // Environment variable assignments with values
  { name: "env_var_leak", pattern: /(ANTHROPIC_API_KEY|SESSION_SECRET|ENCRYPTION_SECRET|AUTH0_CLIENT_SECRET|LINKEDIN_ACCESS_TOKEN)\s*[=:]\s*\S+/i },
];

/**
 * Scan content for leaked secrets and API keys.
 * @param {string} content — Generated post content
 * @returns {{ found: boolean, matches: string[] }}
 */
export function scanForSecrets(content) {
  if (!content || typeof content !== "string") return { found: false, matches: [] };

  const matches = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(name);
    }
  }

  return { found: matches.length > 0, matches };
}

// ── Prompt Leak Patterns ─────────────────────────────────────
// Detect when the AI outputs fragments of its system prompt or
// internal instructions in the generated post.

const PROMPT_LEAK_PATTERNS = [
  // System prompt preamble phrases
  { name: "system_prompt_fragment", pattern: /you are a (linkedin|content|social media) (content\s+)?(writer|creator|generator|assistant)/i },
  { name: "system_context_leak", pattern: /my (system\s+)?(prompt|instructions?) (say|tell|state|indicate|are)/i },

  // Instruction repetition — phrases from the user prompt template
  { name: "instruction_repetition", pattern: /Write in first person\.\s*Sound like a thoughtful practitioner/i },
  { name: "requirement_leak", pattern: /REQUIREMENTS:\s*\n\s*1\.\s*Length:/i },
  { name: "json_format_leak", pattern: /Respond in this exact JSON format:\s*\n\s*\{/i },

  // Research brief markers leaked into output
  { name: "research_marker_leak", pattern: /RESEARCH BRIEF \(use ONLY these verified facts/i },
  { name: "source_rules_leak", pattern: /CRITICAL SOURCE RULES:/i },
  { name: "attribution_rules_leak", pattern: /ATTRIBUTION RULES:\s*\n\s*-\s*Base ALL/i },
];

/**
 * Scan content for system prompt or instruction leaks.
 * @param {string} content — Generated post content
 * @returns {{ found: boolean, matches: string[] }}
 */
export function scanForPromptLeak(content) {
  if (!content || typeof content !== "string") return { found: false, matches: [] };

  const matches = [];
  for (const { name, pattern } of PROMPT_LEAK_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(name);
    }
  }

  return { found: matches.length > 0, matches };
}

// ── Exfiltration Detection ───────────────────────────────────
// Detect attempts to smuggle data out through the published post.

/**
 * Scan content for data exfiltration attempts.
 * @param {string} content — Generated post content
 * @returns {{ found: boolean, matches: string[] }}
 */
export function scanForExfiltration(content) {
  if (!content || typeof content !== "string") return { found: false, matches: [] };

  const matches = [];

  // Base64 blocks — 40+ chars of base64 alphabet is suspicious in a LinkedIn post
  // Normal posts don't contain long base64 strings
  if (/[A-Za-z0-9+/]{40,}={0,2}/.test(content)) {
    matches.push("base64_block");
  }

  // URLs with suspiciously long query parameters (>80 chars of data)
  const urlMatches = content.match(/https?:\/\/[^\s]+/gi) || [];
  for (const url of urlMatches) {
    const queryStart = url.indexOf("?");
    if (queryStart >= 0) {
      const queryString = url.slice(queryStart + 1);
      if (queryString.length > 80) {
        matches.push("suspicious_url_data");
        break;
      }
    }
  }

  // Also check if any URL contains a known secret pattern
  for (const url of urlMatches) {
    if (/sk-ant/i.test(url) || /AKIA[0-9A-Z]{12,}/.test(url) || /ghp_/.test(url)) {
      matches.push("secret_in_url");
      break;
    }
  }

  return { found: matches.length > 0, matches };
}

// ── Combined Filter ──────────────────────────────────────────

/**
 * Run all output security scans on generated content.
 * Call this BEFORE publishPost().
 *
 * @param {string} content — Generated post content
 * @returns {{ blocked: boolean, reason: string, checks: object[] }}
 */
export function runOutputFilter(content) {
  const secretResult = scanForSecrets(content);
  const promptResult = scanForPromptLeak(content);
  const exfilResult = scanForExfiltration(content);

  const checks = [
    { name: "secrets", ...secretResult },
    { name: "prompt_leak", ...promptResult },
    { name: "exfiltration", ...exfilResult },
  ];

  const blocked = secretResult.found || promptResult.found || exfilResult.found;

  const reasons = [];
  if (secretResult.found) reasons.push("Secret detected: " + secretResult.matches.join(", "));
  if (promptResult.found) reasons.push("Prompt leak: " + promptResult.matches.join(", "));
  if (exfilResult.found) reasons.push("Exfiltration: " + exfilResult.matches.join(", "));

  return {
    blocked,
    reason: reasons.join("; ") || "",
    checks
  };
}
