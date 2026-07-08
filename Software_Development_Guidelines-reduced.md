# Software_Development_Guidelines-reduced.md

## CLAUDE RESPONSE MUST-HAVES
Respond to me using concise language. Choose generalizations over verbose details when emitting descriptions and summaries. Conclude response sections with succinct point or actionable next steps.
Do not mix talking points together. Stay focused on a single thought process and follow it through to completion.
If technical a explanation is critical, then show larger portions of the code for the context. Put the code in a panel or text area that highlight any critical parts in context. Add the file path and line numbers on a header above the panel. Make a clear delineation between the functional description is complete and the technical is displayed. Use ◄── arrows to identify your highlights.
When performing code analysis expand your view beyond the single threaded use case, to include variants of the same use case for multiple conditions. This will help find hidden or other edge cases.
Be sure to lean on function names and code anchors rather than line numbers alone to mitigate drift.

## MANDATORY AI "SOFT SKILLS"
- Do not over explain your reasoning.
- Do not emit code with hard coded variables; keep a running list of variables that are hard coded.
- Zip deliveries everytime unless instructed differently. Include changed files only, linkedin-agent/ rooted paths, no package.json, package-lock.json, generated files (src/index.js, public/index.html).
- Zip files are to extract to the path: ../linkedin-agent/.
- Hardcoded values are a delivery defect, not a footnote, not just flagging.

## SYSTEM FACTS
- Code generation will be installed first in a local devenv on the devtest environment.
- Follow a test-driven-development (TDD) lifecycle and dev-test process for the build phase. The TDD Framework is defined in a TDD FRAMEWORK section.
- Use Zero Trust cybersecurity principles.
- developed and tested locally on an Ubuntu virtual machine image container.
 
## CODE GENERATION RULES
- Apply Zero Trust cybersecurity principles everywhere, in every node layer and the UX.
- Apply enterprise architecture design patterns and best practices for distributed computing.
- Make intelligent recommendations for improvements.
- Offer an alternative if a more architecturally sound, resilient, or if a practical changes would result in a better experience.
- 600-line is a soft limit for files.
- Template files (src_templates/, public_templates/) are the source of truth; never edit generated files directly
 
 
LIVE APPLICATION
- The data layer is a Postgresql OLTP database.
- The live URL is alpha.***REMOVED***.

## TDD FRAMEWORK
  1. FUNCTIONAL (base runner, no suffix)
 
  A functional test verifies that a feature performs its intended
  business function, observed through the same interface the business
  or end user actually uses, using representative valid input. It
  treats the implementation as a black box: it supplies input, then
  asserts on observable output and side effects. It answers one
  question: does the feature do what it is supposed to do?
 
  2. ADVERSARIAL (-adversarial runner)
 
  An adversarial test verifies that a feature resists hostile,
  malicious, or malformed input and abuse, observed through the same
  real interface used by the Functional tier. It supplies attacks and
  invalid input, then asserts that the system rejects, contains, or
  safely degrades rather than misbehaving. It answers: does the
  feature protect against threats and resist misuse?
 
  3. DESIGN (-design runner)
 
  A design test verifies that the source conforms to the intended
  design and structure by inspecting the code statically rather than
  executing it. It answers: was it built the way we agreed?
 
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
 
 
