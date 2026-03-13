// ═══════════════════════════════════════════════════════════════
// Topic Definitions & Content Strategy
// ═══════════════════════════════════════════════════════════════

export const TOPICS = [
  {
    id: "ai-practical-benefit",
    name: "Real Ideas to Get Benefit from an AI System",
    hashtags: ["#AI", "#ArtificialIntelligence", "#Productivity", "#Innovation"],
    systemContext: `You are a pragmatic technology strategist writing for LinkedIn.
Your focus: concrete, actionable ideas for getting real value from AI systems — 
not hype, not theory, but things a team or individual can implement THIS QUARTER.

Tone: authoritative but approachable. You've done this work yourself.
Avoid: vaporware promises, "AI will revolutionize everything" platitudes.
Include: specific use cases, realistic timelines, honest trade-offs.`,
    contentAngles: [
      "Automating a specific business process end-to-end with AI",
      "Using AI to augment (not replace) domain expertise",
      "Cost-benefit analysis frameworks for AI adoption",
      "AI-assisted decision-making in high-stakes environments",
      "Building internal AI literacy without a data science team",
      "Prompt engineering as a legitimate operational skill",
      "Small-scale AI wins that build organizational confidence",
      "AI for knowledge management and institutional memory",
      "Measuring ROI on AI investments honestly",
      "When NOT to use AI — recognizing poor-fit problems"
    ]
  },
  {
    id: "ai-guardrails",
    name: "High-Level Tactics for Surrounding AI Systems with Guardrails",
    hashtags: ["#AIGovernance", "#ResponsibleAI", "#AIEthics", "#TechLeadership"],
    systemContext: `You are an AI governance and risk strategist writing for LinkedIn.
Your focus: practical, high-level tactics for building safety and control
around AI deployments — aimed at executives, architects, and team leads.

Tone: measured, strategic, and informed by real failure modes.
Avoid: fearmongering, overly academic language, checkbox compliance thinking.
Include: frameworks, decision trees, real-world analogies, layered defense strategies.`,
    contentAngles: [
      "Input validation and prompt injection defense layers",
      "Output filtering and human-in-the-loop checkpoints",
      "Role-based access control for AI capabilities",
      "Monitoring and observability for AI system behavior drift",
      "Red-teaming AI systems before production deployment",
      "Establishing acceptable-use policies for generative AI",
      "Data governance as the foundation of AI guardrails",
      "Incident response playbooks for AI misbehavior",
      "Vendor risk assessment for third-party AI services",
      "Building a culture of responsible AI experimentation"
    ]
  },
  {
    id: "cybersecurity-incidents",
    name: "Recent Cybersecurity Incidents",
    hashtags: ["#Cybersecurity", "#InfoSec", "#DataBreach", "#ThreatIntel"],
    systemContext: `You are a cybersecurity analyst and communicator writing for LinkedIn.
Your focus: recent cybersecurity incidents — breaches, attacks, vulnerabilities —
analyzed for lessons learned and actionable takeaways.

Tone: urgent but not alarmist. Factual, well-sourced, focused on "so what?"
Avoid: blame-gaming victims, sensationalism, vendor-specific promotion.
Include: attack vectors, timeline, impact scope, defensive lessons, what to do NOW.
IMPORTANT: Always note that details should be verified against primary sources,
as the information landscape around incidents evolves rapidly.`,
    contentAngles: [
      "Major data breaches and what the attack chain looked like",
      "Supply chain compromises and third-party risk lessons",
      "Ransomware campaigns and evolving extortion tactics",
      "Zero-day exploits and the patch-gap problem",
      "Nation-state threat actor campaigns and attribution",
      "Critical infrastructure targeting and OT/ICS security",
      "Cloud misconfigurations leading to data exposure",
      "Social engineering and business email compromise trends",
      "Regulatory and legal consequences of security failures",
      "Incident post-mortems and what defenders got right"
    ]
  },
  {
    id: "cybersecurity-advances",
    name: "Advances in Cybersecurity Technology",
    hashtags: ["#CyberTech", "#SecurityInnovation", "#ZeroTrust", "#ThreatDetection"],
    systemContext: `You are a forward-looking cybersecurity technologist writing for LinkedIn.
Your focus: emerging technologies, tools, frameworks, and methodologies that are
advancing the state of cybersecurity defense.

Tone: optimistic but grounded. Excited about progress, honest about limitations.
Avoid: vendor press-release regurgitation, silver-bullet claims.
Include: how the technology works at a high level, where it fits in defense-in-depth,
maturity level, and who should be paying attention.`,
    contentAngles: [
      "AI/ML-powered threat detection and its current real-world accuracy",
      "Zero Trust architecture implementations and lessons learned",
      "Extended Detection and Response (XDR) platform evolution",
      "Post-quantum cryptography migration strategies",
      "Secure Access Service Edge (SASE) convergence",
      "Deception technology and active defense advances",
      "Software supply chain security tooling (SBOMs, signing, attestation)",
      "Identity-first security and passwordless authentication",
      "Cloud-native application protection platforms (CNAPP)",
      "Automated security validation and breach simulation"
    ]
  }
];

// Topic rotation strategy: weighted random selection
// that avoids repeating the same topic consecutively
// and ensures all topics get coverage over a 2-week window.
export const ROTATION_CONFIG = {
  weights: {
    "ai-practical-benefit": 0.30,
    "ai-guardrails": 0.25,
    "cybersecurity-incidents": 0.25,
    "cybersecurity-advances": 0.20
  },
  maxConsecutiveSameTopic: 1,
  lookbackWindow: 8  // posts
};
