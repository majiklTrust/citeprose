### Overview.

The testing model in this project is not "write some tests." It is a fixed three-tier contract, one per feature, and each tier answers a different question. Getting the tiers confused is the most common way a suite becomes worthless.

**Tier 1, Functional.** Does the feature do the business job? It runs the real code through the real interface a user or the business actually touches, feeds it valid representative input, and asserts on what comes out and what changed. It is a black box. It never looks at source.

**Tier 2, Adversarial.** Does the feature survive hostility? Same interface, same execution, different input. Malformed, forged, injected, cross-tenant. The assertion is always about rejection, containment, safe degradation, or preserved isolation. Never about the happy path.

**Tier 3, Design.** Was it built the way we agreed? This tier never runs anything. It reads source and asserts static properties: component boundaries, dependency direction, exported versus private surface, interface signatures, configuration in place of literals, required security patterns.

The order is fixed: functional, then adversarial, then design.

The second governing idea is **tests come first and must be proven red before the fix exists**. A test that has never failed has proven nothing. And once a test is written, it is never edited simply because it fails. A failing test is either a real defect or a wrong test, and deciding which is a judgment call that gets made out loud, not silently by rewriting the assertion.

The third governing idea is **honesty in reporting**. A skipped test is never counted as a pass. Coverage is reported as it actually is. `FAILED = 0` is the only number that means the same thing on every machine. Pass totals are not portable, because they depend on what happens to be present in that particular tree.

### Technical Detail.

#### Must Do.

**Structure and naming**
- Three suites per feature step, in the order functional, adversarial, design.
- Three-part suite name: `test-<domain>-<family><n>`, where the last character is a single digit.
- The functional tier is the base runner and carries no suffix. The other two carry `-adversarial` and `-design`.

**What a suite is allowed to assert on**
- Assert business functions through programming interfaces: an exported function, an HTTP endpoint, or a CLI.
- Functional and adversarial tiers must execute the code through the interface the real caller uses.
- Design tier must read source and assert static properties only.
- Resolve every configuration value the same way the running code resolves it, in the same precedence order: `.env` value first, then the code's own fallback (for example a DB lookup), then a hardcoded literal only where the code itself uses that same literal.

**Test data**
- Any suite that writes must carry integrated insert and cleanup, with prior-state capture and restore. Seed the tenant honestly, including the RLS policy surface the code expects in production. Two standing harnesses were previously found riding a missing `agent_state` tenant policy and had to be corrected.
- Check the full constraint and trigger surface of any table the step writes before writing the test. DDL first.

**Gates and process**
- Write the test, prove it red, then build the fix.
- Verification gate order before packaging: syntax check, ESM compile, full-tree evaluation, suite run, then packaging.
- `FAILED = 0` is a hard invariant. Never package from a red or dead run.
- Report a skip as a skip. Report a refusal with the refuser's stated reason.

#### Must NOT Do.

**Assertion anti-patterns, all four are explicit prohibitions**
- Never assert against SQL text directly. Go through the programming interface.
- Never assert file existence on the tree. A content check must skip silently when the file is absent, because the delivery tree and the owner's tree are not the same tree.
- Never assert on specific page copy. UI wording is not a contract.
- Never predict a unit's behavior from the suite's own environment or module-resolution context. Assert context-free outcome dichotomies on the unit itself.

**Tier bleed**
- Never put hostile input in the functional tier.
- Never put valid-path behavior in the adversarial tier.
- Never put runtime behavior in the design tier, and never let the design tier execute the feature.

**Process**
- Never change a test because it failed.
- Never write a test after the fix and call it TDD.
- Never report a pass total as a cross-environment invariant. Only `FAILED = 0` travels.
- Never assert against a value the code would not resolve at runtime, and never hardcode a literal the code does not itself hardcode.
- Never leave test data behind, and never mutate production or shared vault rows in place to make a test pass. Experiments run in the Lab or on a lab tenant.

