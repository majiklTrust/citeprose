# LinkedIn AI Content Agent

An autonomous AI agent that generates and publishes LinkedIn content on four constrained topics. All posts are grounded in research from curated RSS feeds and live web search, verified through multi-source corroboration, and subject to automated quality checks before publishing.

## Topics

| Topic | Focus |
|-------|-------|
| **AI Benefits** | Real, actionable ideas for getting value from AI systems |
| **AI Guardrails** | High-level tactics for responsible AI deployment |
| **Cyber Incidents** | Analysis of recent breaches and attacks |
| **Cyber Advances** | Emerging cybersecurity technologies and tools |

## Posting Rules

- **Minimum 2 posts per week** (scheduler checks twice daily)
- **Maximum 4 posts in any rolling 10-day window**
- Minimum 72 hours between consecutive posts (configurable)
- Weighted topic rotation to ensure balanced coverage
- AI quality scoring with auto-retry for low-quality drafts
- **Posts are blocked entirely when fewer than 2 independent verified sources exist**

## Research & Fact-Checking

Every post goes through a multi-stage research pipeline before content is generated. The goal is 100% credibility — no hallucinated statistics, no fabricated sources, no unverified claims.

### Pipeline (3 Anthropic API calls per cycle, ~4.5 minutes)

1. **RSS Feed Monitor** — 15 curated feeds polled hourly, articles stored in SQLite. Feeds are assigned trust tiers (authoritative, primary, secondary) that affect corroboration scoring. No API call — this runs on a background cron job.

2. **Web Search** (API call #1) — Claude searches for current information on the topic angle using the `web_search` tool. Returns 5–15 specific, source-attributed claims.

3. **Rate Limit Cooldown** (65 seconds) — Waits for the Anthropic token-per-minute window to reset.

4. **Corroboration** (API call #2) — A dedicated fact-checking call that cross-references all claims from RSS and web search. Only claims appearing in 2+ independent sources with sufficient trust weight pass through. Statistics and percentages are rejected unless verified by multiple sources.

5. **Rate Limit Cooldown** (65 seconds) — Second wait before content generation.

6. **Content Generation** (API call #3) — Claude writes the post using ONLY verified facts from the corroboration step. The prompt explicitly forbids inventing, embellishing, or including uncorroborated claims. Source attribution is required in the post body.

7. **Quality Check** — Scores the post on 7 criteria including `source_grounding` and `factual_caution`. Posts that score below threshold on either are flagged for rejection.

### Source Trust Tiers

| Tier | Weight | Examples |
|------|--------|----------|
| Authoritative | 3 | CISA, NIST, FBI, NSA, MSRC, Google Project Zero |
| Primary | 2 | Krebs on Security, BleepingComputer, Dark Reading, Schneier, The Record |
| Secondary | 1 | Hacker News, TechCrunch |

Minimum trust weight for corroboration: **3** (e.g., 2 primary sources, or 1 authoritative + 1 secondary).

### Source Blocking

If the research pipeline cannot find at least 2 independent sources that corroborate a claim relevant to the chosen topic and angle, the post is **blocked entirely**. The dashboard shows a clear message explaining why, and the scheduler will try a different topic/angle on the next cycle.

### Attestation

Every published post includes this line at the end:

> Sources verified through multi-source corroboration. Full source list available upon request.

### RSS Feeds (15 curated sources)

Configured in `src/config/feeds.js`:

- **Cybersecurity**: CISA Alerts, Krebs on Security, BleepingComputer, Dark Reading, The Record, The Hacker News, Securelist, Schneier on Security, MSRC, Google Security Blog
- **AI**: Google AI Blog, OpenAI Blog, Anthropic Blog, TechCrunch AI, Simon Willison

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="LinkedIn AI Agent — System Architecture" width="720"/>
</p>

The agent is composed of seven core services wired through a shared SQLite database:

- **Dashboard** — Express server hosting a React control panel at `localhost:3001`. Three-column layout: posts (left), activity log (center), controls (right). Toggle between auto/manual mode, approve or reject queued posts, preview new posts, select topics, and monitor research activity.
- **Scheduler** — A `node-cron` job that checks twice daily whether cadence rules allow a new post (72h minimum gap, 4-post rolling 10-day ceiling). When allowed, it triggers the full research-to-generation pipeline.
- **News Monitor** — Polls 15 curated RSS feeds every hour. Articles are stored in SQLite with trust tier metadata and pruned after 60 days.
- **Research Service** — Gathers source material from RSS and live web search, then runs a corroboration call to cross-reference claims. Only verified facts reach the content generator.
- **Content Generator** — Calls Claude Sonnet via the Anthropic API with topic-specific system prompts, verified research briefs, and strict attribution rules. Each draft goes through an automated quality check; low-scoring posts are regenerated once.
- **LinkedIn API Service** — Handles the full OAuth 2.0 flow and publishes posts via the LinkedIn ugcPosts API (`/v2/ugcPosts`). Token validation runs on each dashboard load.
- **Topic Registry** — Four constrained topic areas with weighted rotation, configurable weights, and a manual topic override from the dashboard.

## Quick Start

### 1. Prerequisites

- **Node.js 22.x**
- **Anthropic API key** — get one at https://console.anthropic.com
- **LinkedIn Developer App** — create at https://www.linkedin.com/developers/apps

### 2. Install

```bash
cd linkedin-agent
npm install
cp .env.example .env
```

### 3. Configure LinkedIn App

1. Go to https://www.linkedin.com/developers/apps
2. Create a new app (or use existing). A Company Page is required to register the app, but posts go to your personal profile.
3. Under **Products**, request access to:
   - "Share on LinkedIn"
   - "Sign In with LinkedIn using OpenID Connect"
4. Under **Auth**, add redirect URL: `http://localhost:3001/auth/linkedin/callback`
5. Copy your Client ID and Client Secret to `.env`

**Note:** The "Share on LinkedIn" product grants `w_member_social` scope, which works with the `/v2/ugcPosts` endpoint. The newer `/rest/posts` endpoint requires Community Management API enrollment and will return 403 without it.

### 4. Set API Keys in `.env`

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
LINKEDIN_CLIENT_ID=your_client_id
LINKEDIN_CLIENT_SECRET=your_client_secret
AGENT_MODE=manual    # Start in manual mode to review posts first
```

### 5. Start the Agent

```bash
npm run dev
```

### 6. Connect LinkedIn

Open `http://localhost:3001` and click the LinkedIn connect link, or run:

```bash
npm run auth
```

Complete the OAuth flow in your browser. The callback page will display your access token and person URN — add both to your `.env` file, then restart the server (`.env` is read once at startup).

### 7. Test Content Generation

Use the **Preview New Post** button on the dashboard. This runs the full research-corroboration-generation pipeline without saving anything to the database or touching LinkedIn. It takes approximately 4.5 minutes due to rate limit cooldowns between API calls.

## Usage

### Dashboard (`http://localhost:3001`)

The dashboard has a three-column layout:

**Left column — Posts:**
- Awaiting Approval queue with corroboration badges (Well corroborated / Limited / Uncorroborated)
- Post history with status indicators
- Click any post to open the detail modal with sources, quality scores, and factual flags

**Center column — Activity Log:**
- Real-time feed of agent actions
- Each entry includes a `cycleId` correlation ID to trace all steps of a single generation cycle

**Right column — Controls:**
- **Topic Selector** — Choose a specific topic or leave on "Auto-select" for weighted rotation
- **Preview New Post** — Run the full pipeline without saving
- **Force Scheduler Cycle** — Trigger the scheduler immediately
- **Research Monitor** — Live feed counts by source with trust tier badges
- **Refresh Feeds Now** — Manually trigger an RSS poll
- **Topic Coverage** — Post counts per topic

### Preview → Queue → Approve Workflow

The recommended workflow avoids burning duplicate API calls:

1. Select a topic (optional) and click **Preview New Post** (~4.5 min)
2. Review the post content, sources, quality scores, and factual flags in the modal
3. Click **Queue for Approval** to save it to the database as pending
4. The post appears in the Awaiting Approval section
5. Click into it and **Approve & Publish** to post to LinkedIn

Or click **Discard** if the post isn't satisfactory.

### Modes

| Mode | Behavior |
|------|----------|
| **Manual** | Agent generates content on schedule, queues it for your approval. You click Approve or Reject. |
| **Auto** | Agent generates and publishes content autonomously within cadence rules. |

### Corroboration Toggle

The dashboard Quick Actions panel includes a toggle switch for corroboration. This controls whether the dedicated fact-checking API call runs during the research pipeline. The setting persists across restarts (stored in SQLite `agent_state`).

| Setting | Pipeline | Cycle Time | Behavior |
|---------|----------|------------|----------|
| **ON** (default) | Web search → 65s cooldown → corroboration → 65s cooldown → generation | ~4.5 min | Only facts verified by 2+ independent sources reach the generator. Attestation line is appended. Badge shows "Well corroborated" or "Limited corroboration". |
| **OFF** | Web search → 65s cooldown → generation | ~2.5 min | Raw source material goes directly to the generator with attribution rules. No attestation line. Badge shows "Corroboration skipped". |

In both modes, the quality check (scoring `source_grounding` and `factual_caution`) still runs, and posts are still blocked when fewer than 2 independent sources exist.

### Topic Rotation

Topic weights are configured in `src/config/topics.js`:

```javascript
ROTATION_CONFIG.weights = {
  "ai-practical-benefit": 0.30,
  "ai-guardrails": 0.25,
  "cybersecurity-incidents": 0.25,
  "cybersecurity-advances": 0.20
}
```

The `maxConsecutiveSameTopic: 1` setting prevents the same topic from posting twice in a row. The dashboard topic selector overrides the rotation for manual actions (Preview, Force Cycle) but does not affect scheduled cron runs.

### Cadence Configuration (`.env`)

```env
MIN_HOURS_BETWEEN_POSTS=72    # Minimum gap between posts
MAX_POSTS_PER_10_DAYS=4       # Hard ceiling per rolling window
PREFERRED_POST_HOUR=9         # What hour to check/generate (local time)
```

The scheduler runs checks twice daily (at the preferred hour and 12 hours later). Changes to `.env` require a server restart.

### Rate Limits

The agent operates within Anthropic's 30,000 input token per minute limit by inserting 65-second cooldowns between API calls. The full pipeline (web search → corroboration → generation) takes approximately 4.5 minutes. Do not click Preview or Force Cycle while a previous cycle is still running.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Agent status, stats, cadence, research stats |
| GET | `/api/posts` | List posts (`?status=pending_approval`) |
| GET | `/api/posts/:id` | Single post detail |
| POST | `/api/posts/:id/approve` | Approve and publish a pending post |
| POST | `/api/posts/:id/reject` | Reject a pending post |
| POST | `/api/mode` | Set mode (`{ "mode": "auto" }`) |
| POST | `/api/pause` | Pause agent (`{ "paused": true }`) |
| POST | `/api/corroboration` | Toggle corroboration (`{ "enabled": false }` to skip) |
| POST | `/api/generate-preview` | Generate a preview (`{ "topicId": "ai-guardrails" }` optional) |
| POST | `/api/save-preview` | Save a previewed post to the approval queue |
| POST | `/api/force-cycle` | Trigger scheduler cycle (`{ "topicId": "..." }` optional) |
| GET | `/api/logs` | Activity log |
| GET | `/api/research/stats` | RSS article counts by feed |
| GET | `/api/research/articles` | Articles for a topic (`?topic=cybersecurity-incidents&maxAge=14`) |
| POST | `/api/research/poll` | Manually trigger RSS feed refresh |

## Token Refresh

LinkedIn access tokens expire after 60 days. Other scenarios that require re-authentication:

- Changing app scopes in the LinkedIn Developer Portal
- Manually revoking access from LinkedIn account settings
- Changing your LinkedIn password
- LinkedIn revoking the token for policy or security reasons
- Modifying or deleting the Developer App (client secret rotation, redirect URI change)

To refresh:

1. Run `npm run auth`
2. Complete the OAuth flow
3. Update `LINKEDIN_ACCESS_TOKEN` in `.env`
4. Restart the agent

## Scope Limitations (v1)

This agent **only creates original posts** to your profile. By design, it does NOT:

- Reply to or comment on other people's posts
- React to or engage with external content
- Send connection requests or messages
- Share or repost others' content

These boundaries can be expanded in future versions.

## File Structure

```
linkedin-agent/
├── .env.example              # Environment template
├── package.json
├── public/
│   └── index.html            # Dashboard React app (built from public_templates/)
├── public_templates/
│   └── index.html            # Dashboard template with {{VERSION}} placeholder
├── scripts/
│   ├── linkedin-auth.js      # OAuth setup helper
│   ├── suppress-warnings.cjs # Node.js deprecation warning filter
│   └── test-post.js          # Test content generation
├── src/
│   ├── index.js              # Main entry point
│   ├── config/
│   │   ├── topics.js         # Topic definitions, rotation weights, content angles
│   │   └── feeds.js          # RSS feed URLs, trust tiers, source rules
│   ├── routes/
│   │   └── api.js            # Express API routes
│   └── services/
│       ├── content-generator.js  # Research-grounded generation + quality check
│       ├── database.js           # SQLite persistence
│       ├── linkedin-api.js       # LinkedIn OAuth & posting (ugcPosts)
│       ├── news-monitor.js       # RSS feed polling & article storage
│       ├── research.js           # Web search + corroboration pipeline
│       └── scheduler.js          # Cadence engine + post execution
└── data/
    └── agent.db              # SQLite database (auto-created)
```
