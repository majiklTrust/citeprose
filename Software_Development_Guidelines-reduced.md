# Software_Development_Guidelines-reduced.md

## CLAUDE RESPONSE MUST-HAVES

- Respond to me using concise language. Choose generalizations over verbose details when emitting descriptions and summaries. Conclude - response sections with succinct point or actionable next steps.
- Do not mix talking points together. Stay focused on a single thought process and follow it through to completion.
- If technical a explanation is critical, then show larger portions of the code for the context. Put the code in a panel or text area - that highlight any critical parts in context. Add the file path and line numbers on a header above the panel. Make a clear - delineation between the functional description is complete and the technical is displayed. Use ◄── arrows to identify your highlights.
- When performing code analysis expand your view beyond the single threaded use case, to include variants of the same use case for - multiple conditions. This will help find hidden or other edge cases.
- Be sure to lean on function names and code anchors rather than line numbers alone to mitigate drift.

## APPLICATION ENVIRONMENTS

- The "live" environment is a full-featured hosted on AWS at URL `***REMOVED***`. Static web content stored on S3, served through CloudFront. Use Cloudflare for DNS with CNAME flattening with a canonical redirect to resolve `www.`, `app0.`, and `***REMOVED***` all the same.
- The "devenv" environment is a full-featured local development, devtest, environment that goes through Auth0 for authentication.
- The "override" environment is a full-featured local development environment that has `DEV_BYPASS_ORIGINS` and `DEV_BYPASS_SUB` set.
- The "alpha" environment is a full-featured hosted on AWS at URL `***REMOVED***`. Static web content stored on S3, served through CloudFront.

## MANDATORY AI "SOFT SKILLS"

- Do not over explain your reasoning.
- Do not emit code with hard coded variables; keep a running list of variables that are hard coded.
- Hardcoded values are a delivery defect, not a footnote, not just flagging.

## PROJECT TECHNIAL

- The is a webapp is a ReactJS UX and Node.js tiered routing, service, and other software design layers. The persisteny backend is a PostgreSQL OLTP database.
- The data layer is a Postgresql OLTP database that is local to the application server in all environments.
- Scripts (`.js`/`.css` and web-based code files) have a target legth of 600 lines. Use multiple files instead of limiting functionality. Always identify, then communicate downstream impacts plus adjacent opportunities to consolidate code file before splitting an oversided file.
- I own the versioning strategy. You are responsible for delivering versioned `.zip` files. Version numbering will folllow major/minor/patch numbering, e.g., `0.0.0`. Every delivery should increment the third integer by `1`, e.g., if the version is `0.0.0`, then next version is `0.0.1` and the archive will be named `LinkedIn_Agent-0.0.1.zip`, then `LinkedIn_Agent-0.0.2.zip`.
- Keep the project directory structure in the `.zip` archive, include only changed files, and the `.zip` archive will extract to path: `../linkedin-agent/`.
- Zip deliveries everytime unless instructed differently. Include changed files only,` linkedin-agent/` rooted paths, no `package.json`, `package-lock.json`, generated files (`src/index.js`, `public/index.html`). Do not send individual files or CHANGES.md unless requested.
- Code is installed and run local devenv in a devtest environment.
- Follow a test-driven-development (TDD) lifecycle and dev-test process for the build phase. The TDD Framework is defined in a TDD FRAMEWORK section.
- Deployment support is for the live site. If you are ever unsure of which environment a prompt is for, then you are to ask a question and no make an assumption.
 
## CODE GENERATION RULES

- Apply Zero Trust cybersecurity principles everywhere, in every node layer and the UX.
- Apply enterprise architecture design patterns and best practices for distributed computing.
- Make intelligent recommendations for improvements.
- DO NOT name functions as property or constants. Use getter and setter functions/methods that follow conventional naming standards, e.g., a function to get `SOME_PROPERTY` would be named `getSomePropery()`.
- Offer an alternative if a more architecturally principled, resilient, or if a change would result in a more simple end-user workflow or better human end-user experience. Justify the change using succint and targetted language for the reasons why.
- 600-line file cap on new files. Keep architecture best practices for distributed computing a priority.
- Template files (`src_templates/`, `public_templates/`) are the source of truth; never edit generated files directly

## TDD FRAMEWORK

  Each feature is tested by three suites. Tier-1 and Tier-2 run the
  code and observe behavior through the real interface; they differ
  only in the input they supply. The third tier does not run the
  code; it inspects the source.

  1. FUNCTIONAL (base runner, no suffix; -functional runner)

  A functional test verifies that a feature performs its intended
  business function, observed through the same interface the business
  or end user actually uses, using representative valid input. It
  treats the implementation as a black box: it supplies input, then
  asserts on observable output and side effects. It answers one
  question: does the feature do what it is supposed to do?

    Method: executes the code through its real interface (HTTP
      endpoint, exported function, or CLI).
    Asserts: correct observable results and side effects for valid,
      representative business cases.
    Excludes: hostile input, which belongs to the Adversarial tier,
      and inspection of source structure, which belongs to the Design
      tier.

    Configuration values: a functional test must resolve any
    configuration value the same way the running code resolves it, in
    the same order of precedence. Prefer the .env property value when
    it is available. When the .env value is absent, fall back exactly
    as the code falls back, for example to a database lookup, and use
    a hardcoded literal only as a last resort, and only where the code
    itself uses that same hardcoded default. The test must never
    assert against a value the code would not actually resolve at
    runtime.

    Example: given a user-chosen topic, the agent ingests current
    content from the configured external feeds, performs research, and
    returns a business-appropriate social media post through the
    generation interface. The feed endpoints, model identifier, and
    token limits are read from .env when present, falling back to the
    code's own sources and defaults in the code's own order.

  2. DESIGN (-design runner)

  A design test verifies that the source conforms to the intended
  design and structure by inspecting the code statically rather than
  executing it. It answers: was it built the way we agreed?

    Method: reads source files and asserts static properties. It never
      runs the feature.
    Excludes: any runtime behavior, which belongs to the Functional
      and Adversarial tiers.

    The Design tier covers two facets, both asserted by static
    inspection:
      Architectural facet: the high-level structure, including
        component boundaries, dependency direction, layering, the
        wiring between components, and what is exported versus kept
        private.
      Detailed-design facet: the decisions made within that structure,
        including interface contracts and signatures, configuration in
        place of hardcoded values, naming and file conventions, and
        required security patterns.

    Example: the authentication layer imports only Node built-ins, the
    generation service exports the agreed named functions and no
    default export, encryption uses AES-256-GCM with a derived key,
    and no secret is hardcoded in source.

  3. ADVERSARIAL (-adversarial runner)

  An adversarial test verifies that a feature resists hostile,
  malicious, or malformed input and abuse, observed through the same
  real interface used by the Functional tier. It supplies attacks and
  invalid input, then asserts that the system rejects, contains, or
  safely degrades rather than misbehaving. It answers: does the
  feature protect against threats and resist misuse?

    Method: executes the code through its real interface, the same as
      Functional, but with hostile input.
    Asserts: rejection, containment, safe failure, and preserved
      isolation between tenants and users.
    Excludes: valid-path behavior, which belongs to the Functional
      tier, and source inspection, which belongs to the Design tier.

    Example: a forged callback state is rejected, a prompt-injection
    payload embedded in ingested feed content does not alter the
    generated post's instructions, and a request for another tenant's
    topic is denied.
  
