// ═══════════════════════════════════════════════════════════════
// RSS Feed Configuration — Curated sources for each topic area
// ═══════════════════════════════════════════════════════════════

export const FEEDS = [
  // ── Cybersecurity Incidents & Threat Intel ─────────────────
  {
    url: "https://krebsonsecurity.com/feed/",
    name: "Krebs on Security",
    topicIds: ["cybersecurity-incidents"],
    tier: "primary",
    refreshMinutes: 120
  },
  {
    url: "https://www.bleepingcomputer.com/feed/",
    name: "BleepingComputer",
    topicIds: ["cybersecurity-incidents", "cybersecurity-advances"],
    tier: "primary",
    refreshMinutes: 60
  },
  {
    url: "https://therecord.media/feed",
    name: "The Record by Recorded Future",
    topicIds: ["cybersecurity-incidents"],
    tier: "primary",
    refreshMinutes: 120
  },
  {
    url: "https://www.darkreading.com/rss.xml",
    name: "Dark Reading",
    topicIds: ["cybersecurity-incidents", "cybersecurity-advances"],
    tier: "primary",
    refreshMinutes: 120
  },
  {
    url: "https://feeds.feedburner.com/TheHackersNews",
    name: "The Hacker News",
    topicIds: ["cybersecurity-incidents", "cybersecurity-advances"],
    tier: "secondary",
    refreshMinutes: 90
  },
  {
    url: "https://www.cisa.gov/news.xml",
    name: "CISA Alerts",
    topicIds: ["cybersecurity-incidents"],
    tier: "authoritative",
    refreshMinutes: 180
  },
  {
    url: "https://securelist.com/feed/",
    name: "Securelist (Kaspersky)",
    topicIds: ["cybersecurity-incidents", "cybersecurity-advances"],
    tier: "primary",
    refreshMinutes: 240
  },

  // ── Cybersecurity Technology & Advances ────────────────────
  {
    url: "https://www.schneier.com/feed/atom/",
    name: "Schneier on Security",
    topicIds: ["cybersecurity-advances", "ai-guardrails"],
    tier: "primary",
    refreshMinutes: 240
  },
  {
    url: "https://blog.google/technology/safety-security/rss/",
    name: "Google Security Blog",
    topicIds: ["cybersecurity-advances"],
    tier: "primary",
    refreshMinutes: 360
  },
  {
    url: "https://api.msrc.microsoft.com/update-guide/rss",
    name: "Microsoft Security Response Center",
    topicIds: ["cybersecurity-advances", "cybersecurity-incidents"],
    tier: "authoritative",
    refreshMinutes: 360
  },

  // ── AI Practical Benefits & Guardrails ─────────────────────
  {
    url: "https://blog.google/technology/ai/rss/",
    name: "Google AI Blog",
    topicIds: ["ai-practical-benefit"],
    tier: "primary",
    refreshMinutes: 360
  },
  {
    url: "https://openai.com/blog/rss.xml",
    name: "OpenAI Blog",
    topicIds: ["ai-practical-benefit", "ai-guardrails"],
    tier: "primary",
    refreshMinutes: 360
  },
  {
    url: "https://www.technologyreview.com/feed/",
    name: "MIT Technology Review",
    topicIds: ["ai-practical-benefit", "ai-guardrails"],
    tier: "primary",
    refreshMinutes: 240
  },
  {
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    name: "TechCrunch AI",
    topicIds: ["ai-practical-benefit"],
    tier: "secondary",
    refreshMinutes: 120
  },
  {
    url: "https://simonwillison.net/atom/everything/",
    name: "Simon Willison",
    topicIds: ["ai-practical-benefit", "ai-guardrails"],
    tier: "primary",
    refreshMinutes: 240
  }
];

// Source trust tiers — used during corroboration scoring
export const TRUST_TIERS = {
  authoritative: { weight: 3, label: "Official / Government" },
  primary:       { weight: 2, label: "Original Reporting" },
  secondary:     { weight: 1, label: "Aggregator / Commentary" }
};

// Minimum number of distinct, independent source names required before
// there is "enough material" to generate. Configurable at deploy time via
// MIN_INDEPENDENT_SOURCES (integer >= 1, capped at 10). Falls back to 2 if
// the env var is unset, non-numeric, or out of range — so a bad value can
// never disable the gate or starve generation silently.
function readMinIndependentSources() {
  const raw = process.env.MIN_INDEPENDENT_SOURCES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 2;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n < 1) return 2;
  return Math.min(n, 10);
}

// Minimum source requirements — posts are blocked if not met
export const SOURCE_RULES = {
  // Distinct independent source names required (env: MIN_INDEPENDENT_SOURCES,
  // default 2). Read once at module load; change requires a restart.
  minIndependentSources: readMinIndependentSources(),

  // Minimum cumulative trust weight for corroboration to pass
  // e.g., 3 = two primary sources, or one authoritative + one secondary
  minTrustWeight: 3,

  // Maximum age of articles considered "current" for each topic
  maxAgeDays: {
    "cybersecurity-incidents": 14,
    "cybersecurity-advances": 30,
    "ai-practical-benefit": 30,
    "ai-guardrails": 30
  }
};
