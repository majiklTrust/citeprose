-- ═══════════════════════════════════════════════════════════════
-- seed-topics.sql — Seed default topics for a tenant
-- ═══════════════════════════════════════════════════════════════
-- Run AFTER the tenant exists in the database.
-- Run BEFORE seed-feeds.sql (feeds map to topic slugs).
-- This is NOT part of the schema build — it's operational data.
--
-- Usage:
--   psql -U $PGUSER -d $PGDATABASE \
--     -v tenant_id="'<tenant-uuid>'" \
--     -f data/pgsql/seed-topics.sql
--
-- Idempotent: ON CONFLICT (tenant_id, slug) DO NOTHING.
-- ═══════════════════════════════════════════════════════════════

-- Pass the tenant UUID into the DO block via a session setting.
SELECT set_config('seed.tenant_id', :'tenant_id', false);

DO $$
DECLARE
  v_tenant UUID := current_setting('seed.tenant_id')::uuid;
BEGIN
  -- Set tenant context for RLS
  PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

  -- ── AI Practical Benefit ───────────────────────────────────

  INSERT INTO topics (
    tenant_id, slug, name, description,
    content_angles, hashtags, system_context,
    weight, max_age_days, enabled, sort_order
  ) VALUES (
    v_tenant,
    'ai-practical-benefit',
    'AI Practical Benefit',
    'How organizations are using artificial intelligence to solve real business problems and deliver measurable value',
    '[
      "Real-world AI implementation success stories with measurable ROI",
      "How mid-market companies are adopting AI without massive budgets",
      "AI-driven automation replacing manual workflows in specific industries",
      "Practical lessons learned from failed and successful AI deployments",
      "AI tools that non-technical leaders can deploy today"
    ]'::jsonb,
    '["#AI", "#ArtificialIntelligence", "#AIinBusiness", "#DigitalTransformation", "#MachineLearning", "#Innovation"]'::jsonb,
    'You are a LinkedIn content strategist focused on practical AI applications in business. Write about real implementations, measurable outcomes, and actionable insights. Avoid hype and speculation. Ground every claim in a specific example or data point from your research. Target audience: business leaders and technology decision-makers.',
    1, 20, true, 1
  ) ON CONFLICT (tenant_id, slug) DO NOTHING;

  -- ── AI Guardrails ──────────────────────────────────────────

  INSERT INTO topics (
    tenant_id, slug, name, description,
    content_angles, hashtags, system_context,
    weight, max_age_days, enabled, sort_order
  ) VALUES (
    v_tenant,
    'ai-guardrails',
    'AI Guardrails',
    'Responsible AI governance, safety frameworks, regulatory compliance, and ethical deployment practices',
    '[
      "Input validation and prompt injection defense layers",
      "AI governance frameworks that actually work in practice",
      "Regulatory developments shaping AI deployment requirements",
      "Building trust in AI systems through transparency and explainability",
      "Lessons from AI incidents and how organizations responded"
    ]'::jsonb,
    '["#AIGovernance", "#ResponsibleAI", "#AISafety", "#AIEthics", "#AIRegulation", "#TrustInAI"]'::jsonb,
    'You are a LinkedIn content strategist focused on AI safety, governance, and responsible deployment. Write about frameworks, policies, and practical safeguards that organizations are implementing. Balance urgency with pragmatism. Target audience: CISOs, CTOs, compliance leaders, and AI program managers.',
    1, 20, true, 2
  ) ON CONFLICT (tenant_id, slug) DO NOTHING;

  -- ── Cybersecurity Incidents ────────────────────────────────

  INSERT INTO topics (
    tenant_id, slug, name, description,
    content_angles, hashtags, system_context,
    weight, max_age_days, enabled, sort_order
  ) VALUES (
    v_tenant,
    'cybersecurity-incidents',
    'Cybersecurity Incidents',
    'Analysis of recent breaches, ransomware attacks, vulnerability disclosures, and threat intelligence',
    '[
      "Recent breach analysis — what happened and what leaders should learn",
      "Ransomware trends and evolving attacker tactics",
      "Critical vulnerability disclosures and patching priorities",
      "Supply chain attacks and third-party risk lessons",
      "Incident response lessons from real-world cases"
    ]'::jsonb,
    '["#Cybersecurity", "#InfoSec", "#DataBreach", "#Ransomware", "#ThreatIntel", "#IncidentResponse"]'::jsonb,
    'You are a LinkedIn content strategist focused on cybersecurity incidents and threat intelligence. Write about recent events with factual analysis, actionable takeaways, and lessons for defenders. Avoid sensationalism. Every post must reference specific, verifiable incidents from your research. Target audience: CISOs, security engineers, and IT leaders.',
    1, 20, true, 3
  ) ON CONFLICT (tenant_id, slug) DO NOTHING;

  -- ── Cybersecurity Advances ─────────────────────────────────

  INSERT INTO topics (
    tenant_id, slug, name, description,
    content_angles, hashtags, system_context,
    weight, max_age_days, enabled, sort_order
  ) VALUES (
    v_tenant,
    'cybersecurity-advances',
    'Cybersecurity Advances',
    'New defensive technologies, security tools, research breakthroughs, and evolving best practices',
    '[
      "New security tools and platforms solving real defender problems",
      "Zero trust architecture adoption — progress and challenges",
      "Cloud security innovations and emerging best practices",
      "Security research breakthroughs from academic and vendor labs",
      "How AI and automation are transforming security operations"
    ]'::jsonb,
    '["#Cybersecurity", "#InfoSec", "#ZeroTrust", "#CloudSecurity", "#SecurityOps", "#CyberDefense"]'::jsonb,
    'You are a LinkedIn content strategist focused on cybersecurity technology and defensive innovation. Write about new tools, research breakthroughs, and evolving practices that help organizations defend themselves. Balance technical depth with accessibility. Target audience: security architects, engineers, and technology leaders.',
    1, 20, true, 4
  ) ON CONFLICT (tenant_id, slug) DO NOTHING;

END$$;
