#!/bin/bash

cp package-lock.json package-lock.json.bak.nogit

npm ci --ignore-scripts
npm -v                  # 11.16.0+ enables Step 3b's allowlist
npm ls axios            # must NOT be 1.14.1
npm pkg get scripts     # confirm no preinstall|install|postinstall|prepare does real work (build)
npm pkg get scripts|grep -E "preinstall|install|postinstall|prepare"

# Authenticity verification (your "fingerprint or other means"):
# The integrity hash is the fingerprint — already enforced by lockfile + npm ci.
# npm audit signatures verifies the registry's signature on each package plus any
npm audit signatures
npm audit --audit-level=high
npm audit --audit-level=medium

# provenance proves origin, not safety
npm audit signatures --json --include-attestations

npm install --package-lock-only
git add package-lock.json && git commit -m "lock dependency tree"

cat >.npmrc <<EOF 
save-exact=true
EOF

npx lockfile-lint --path package-lock.json --type npm --validate-https --allowed-hosts npm --validate-integrity

# THIS ESSENTIALLY DOES AN UPGRADE
# npx npm-check-updates --target patch -u   # review the diff, then: npm install && npm ci
# npx lockfile-lint --path package-lock.json --type npm --validate-https --allowed-hosts npm --validate-integrity

# SOFTWARE BILL OF MATERIALS
# An SBOM is a reactive artifact, not a runtime one — you don't use it day to day; you use it when something breaks.
# Exposure check. Next time an advisory says "package X@Y is malicious/vulnerable," you grep the SBOM and instantly know if and where you're hit — no re-resolving trees across services.
# Continuous vuln matching. Feed it to a scanner (Grype, Trivy, OSV-Scanner, Dependabot) so a CVE disclosed tomorrow against something you shipped today gets flagged, even though it was clean at build time.
# Compliance. SOC 2 and enterprise security questionnaires increasingly ask for one — relevant for a B2B SaaS.
# Diff. Compare SBOMs across releases to see exactly what entered your dependency surface between, say, 1.9.24 and 1.9.25.
npm ci --ignore-scripts
npm sbom --sbom-format cyclonedx --omit=dev >sbom.cdx.json\
  && git add sbom.cdx.json

mkdir -p .github
cat >.github/dependabot.yml <<EOF
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule: { interval: "weekly" }
    cooldown: { default-days: 7, semver-minor-days: 3, semver-patch-days: 3 }
    open-pull-requests-limit: 5
EOF
