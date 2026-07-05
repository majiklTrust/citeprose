# Prompt: LinkedIn MDP Feature, Full Lifecycle (Research, Design, Implementation, Delivery)

## Mandate

Research LinkedIn's Marketing Developer Platform, select ONE high value feature using independent judgment, then design and fully implement it. This is not a design only exercise. The end state is delivered, working code, packaged per the delivery rules below. Broad decision making authority applies to feature selection, architecture, and implementation detail. It does not override the gate checks in this prompt.

## Required Reading Before Any Decision

1. Project file: LinkedIn Marketing API Release Q2 2026 email. Treat as the primary trigger for what is newly possible.
2. Current LinkedIn Marketing Developer Platform documentation, fetched live, not from training memory. LinkedIn API terms and access tiers change and Claude's own knowledge cutoff predates this release.
3. Product and architecture context below.

## Product Context

Multi tenant B2B SaaS. Ingests RSS/Atom research feeds, synthesizes content with AI, publishes finished posts to LinkedIn organization pages on behalf of tenants. End users choose the research topics.

Stack: Node.js current LTS, ESM, Express, PostgreSQL with forced row level security, Auth0 plus WorkOS, per tenant AES 256 GCM plus HKDF encryption for stored credentials.

Known standing gaps relevant to this decision:
- No engagement or performance data flows back from LinkedIn into the product today. The AI generates and publishes content and the loop ends there.
- Image attachment is deferred pending Community Management API approval.
- Per user content isolation (personal profile posting) is a future item, not current state.

## Known Constraints (verified against current LinkedIn documentation, re verify before relying on this if this prompt is run more than a few weeks after it was written)

- LinkedIn Marketing Developer Platform access is tiered (Development, Standard) and most capability beyond basic sign in requires partner approval. Approval timelines run weeks to months.
- Community Management API covers organization page posting and organization page analytics, and separately member level post analytics through a distinct closed permission. Organization level and member level are not the same grant.
- Advertising API, Company Intelligence API, Ad Analytics API, Conversions API, Predictive Audiences API, and Dynamic UTM API all sit behind Advertising API access tied to ad accounts. These do not apply to an organic, non paid content workflow unless tenants also run paid campaigns.
- `organizationalEntityShareStatistics` returns per post organic metrics (impressions, clicks, likes, comments, shares, engagement rate) for organization pages, rolling 12 month window unless lifetime totals are requested. This is scoped to organization pages the app already administers for posting, which is the same surface this product already writes to.

Do not treat the constraints above as settled fact for the account in question. Verify against the actual granted LinkedIn app products and scopes in the live environment before committing to a feature that depends on them.

## Feature Selection Method

Score every candidate against:
1. Visible business value. The feature must appear somewhere a business user looks, a dashboard, a post detail view, a report. Backend only plumbing does not qualify on its own.
2. Fit with data the product already has permission to access, or a clearly scoped new permission request.
3. Buildable without a new LinkedIn approval bet, or if it does require one, explicitly flagged as such with the approval timeline named as a project risk.
4. Incremental. No ground up rewrite of the publishing pipeline or credential model.

Present two or three candidates considered, why each was or was not chosen, before committing to one. If the honest answer is that the newest items in the Q2 2026 release do not fit this product's organic, non paid workflow, say so rather than forcing a weak fit.

## Gate Checks Before Any Code Is Written

1. Current version number. If not supplied or not confirmable, stop and ask before proceeding to implementation. Do not guess.
2. Current source tree. Confirm the merged base being worked from is the current one. If no source tree has been provided in this conversation, ask for it, do not reconstruct files from memory of past sessions.
3. Actual granted LinkedIn app scopes and product access for this tenant integration. Verify in the live codebase or configuration, do not assume from generic documentation.

None of these gate checks are satisfied by assumption. All three must be explicitly confirmed before a zip is produced.

## Implementation Requirements

- 600 line soft cap per file. Split functionality across multiple files rather than exceeding it.
- No hardcoded values. Maintain a running list of anything hardcoded during the build, and remove it before delivery, not flag it after.
- Zero Trust throughout, including the UI layer. Fail closed on missing scope, missing tenant context, or missing config.
- Credential and token handling follows the existing per tenant AES 256 GCM plus HKDF pattern. No new plaintext handling of tokens.
- Follow the three tier TDD model for the build phase: functional, adversarial, design. Confirm a red baseline before writing fixes.
- Every substantive response is tagged with exactly one SDLC phase: design, build, test, or deploy.
- Functional description is written first, complete, and kept separate from technical detail. Technical detail follows with a clear visual break between the two.
- Code shown in a response uses a header line above the code panel with file path and line range, no inline line numbers inside the panel, and critical lines marked with a comment call out, disclaimed as an addition rather than original code.
- No en dashes or em dashes anywhere in generated content: code, comments, documentation, commit style descriptions, or conversational text. This applies to everything produced under this prompt without exception.

## Delivery Packaging Rules

- Zip delivery, project directory structure preserved, changed files only.
- Version the delivery by incrementing the fourth digit of whatever version number was supplied. If the fourth digit was not specified, treat it as 0 before incrementing.
- Exclude package.json, package lock, and any generated files (anything produced by a build step from a template source).
- Do not include individual loose files or a CHANGES.md unless explicitly requested.

## Suggested Sequencing

Given the scope, expect this to span multiple responses rather than one:
1. Research and candidate scoring, tagged design.
2. Chosen feature functional and technical design, tagged design, presented before code is written so direction can be corrected cheaply.
3. Implementation, tagged build, following the TDD lifecycle.
4. Test execution and results, tagged test.
5. Packaged delivery, tagged deploy.

Do not skip straight to a zip on the first response. The gate checks above make that impossible to do correctly on the first pass in any case.
