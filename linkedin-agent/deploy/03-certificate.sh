#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3: ACM Certificate (HTTPS)
# ═══════════════════════════════════════════════════════════════
# After this script, you must create a DNS record at your
# registrar for certificate validation. The script will tell
# you exactly what record to create.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 3: ACM Certificate for ${FQDN}"

# ── Request Certificate ───────────────────────────────────────
step "Requesting ACM certificate for ${FQDN}"

CERT_ARN=$(aws acm request-certificate \
  --domain-name "$FQDN" \
  --validation-method DNS \
  --query 'CertificateArn' --output text \
  --tags "Key=Name,Value=${PROJECT}-cert" "Key=Project,Value=${PROJECT}")

save_state CERT_ARN "$CERT_ARN"
info "Certificate ARN: $CERT_ARN"

# ── Wait for validation details ──────────────────────────────
step "Waiting for DNS validation details..."
sleep 5

# Extract the CNAME record needed for validation
VALIDATION_JSON=$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord')

CNAME_NAME=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Name'])" 2>/dev/null)
CNAME_VALUE=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Value'])" 2>/dev/null)

if [ -z "$CNAME_NAME" ] || [ -z "$CNAME_VALUE" ]; then
  warn "Validation details not ready yet. Retrying in 10s..."
  sleep 10
  VALIDATION_JSON=$(aws acm describe-certificate \
    --certificate-arn "$CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord')
  CNAME_NAME=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Name'])")
  CNAME_VALUE=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Value'])")
fi

save_state CERT_CNAME_NAME "$CNAME_NAME"
save_state CERT_CNAME_VALUE "$CNAME_VALUE"

# ── Instructions ──────────────────────────────────────────────
banner "ACTION REQUIRED: Create DNS Record"
echo "  Go to your DNS provider for ${DOMAIN} and create this record:"
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Type:  CNAME                                           │"
echo "  │  Name:  ${CNAME_NAME}"
echo "  │  Value: ${CNAME_VALUE}"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
echo "  NOTE: Some registrars want just the subdomain part of Name"
echo "  (everything before .${DOMAIN}). Others want the full FQDN."
echo "  If your registrar auto-appends the domain, use only the prefix."
echo ""
echo "  After creating the record, run:"
echo ""
echo "    bash 03b-wait-cert.sh"
echo ""
echo "  This will poll until the certificate validates (usually 2-15 minutes)."
