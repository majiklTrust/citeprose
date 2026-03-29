#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 5: Application Load Balancer + HTTPS Listener
# ═══════════════════════════════════════════════════════════════
# After this script, you must create a CNAME record pointing
# agent.contosorealtime.com to the ALB DNS name.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 5: Application Load Balancer"

SUBNET_1_ID=$(require_state SUBNET_1_ID)
SUBNET_2_ID=$(require_state SUBNET_2_ID)
ALB_SG_ID=$(require_state ALB_SG_ID)
CERT_ARN=$(require_state CERT_ARN)
TG_ARN=$(require_state TG_ARN)

# ── Verify certificate is issued ─────────────────────────────
step "Verifying certificate status"

CERT_STATUS=$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)

if [ "$CERT_STATUS" != "ISSUED" ]; then
  err "Certificate status is '${CERT_STATUS}', expected 'ISSUED'."
  echo "  Run 03b-wait-cert.sh first."
  exit 1
fi
info "Certificate: ISSUED"

# ── Create ALB ────────────────────────────────────────────────
step "Creating Application Load Balancer"

ALB_ARN=$(aws elbv2 create-load-balancer \
  --name "${PROJECT}-alb" \
  --subnets "$SUBNET_1_ID" "$SUBNET_2_ID" \
  --security-groups "$ALB_SG_ID" \
  --scheme internet-facing \
  --type application \
  --ip-address-type ipv4 \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text \
  --tags "Key=Name,Value=${PROJECT}-alb" "Key=Project,Value=${PROJECT}")

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)

ALB_ZONE=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)

save_state ALB_ARN "$ALB_ARN"
save_state ALB_DNS "$ALB_DNS"
save_state ALB_ZONE "$ALB_ZONE"
info "ALB: $ALB_ARN"
info "ALB DNS: $ALB_DNS"

# ── HTTPS Listener (443) ─────────────────────────────────────
step "Creating HTTPS listener (443 → target group)"

HTTPS_LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn "$ALB_ARN" \
  --protocol HTTPS \
  --port 443 \
  --certificates "CertificateArn=${CERT_ARN}" \
  --ssl-policy "ELBSecurityPolicy-TLS13-1-2-2021-06" \
  --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" \
  --query 'Listeners[0].ListenerArn' --output text)

save_state HTTPS_LISTENER_ARN "$HTTPS_LISTENER_ARN"
info "HTTPS listener: $HTTPS_LISTENER_ARN"
info "TLS policy: ELBSecurityPolicy-TLS13-1-2-2021-06 (TLS 1.3 + 1.2)"

# ── HTTP Listener (80 → redirect to HTTPS) ───────────────────
step "Creating HTTP→HTTPS redirect listener (80 → 443)"

HTTP_LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn "$ALB_ARN" \
  --protocol HTTP \
  --port 80 \
  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
  --query 'Listeners[0].ListenerArn' --output text)

save_state HTTP_LISTENER_ARN "$HTTP_LISTENER_ARN"
info "HTTP redirect listener: $HTTP_LISTENER_ARN"

# ── Wait for ALB provisioning ─────────────────────────────────
step "Waiting for ALB to become active"

aws elbv2 wait load-balancer-available --load-balancer-arns "$ALB_ARN"
info "ALB is active"

# ── Instructions ──────────────────────────────────────────────
banner "ACTION REQUIRED: Create DNS Record"
echo "  Go to your DNS provider for ${DOMAIN} and create this record:"
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Type:  CNAME                                           │"
echo "  │  Name:  ${SUBDOMAIN}                                    │"
echo "  │  Value: ${ALB_DNS}                                      │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
echo "  This points ${FQDN} to the load balancer."
echo "  DNS propagation typically takes 1-5 minutes."
echo ""
echo "  Verify with:  dig CNAME ${FQDN}"
echo "  Expected:     ${FQDN} → ${ALB_DNS}"
echo ""
echo "  After DNS propagates, run:  bash 06-application.sh"
