#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 7: Deployment Verification
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 7: Deployment Verification"

EIP_PUBLIC=$(require_state EIP_PUBLIC)
KEY_PATH=$(require_state KEY_PATH)
ALB_DNS=$(require_state ALB_DNS)
TG_ARN=$(require_state TG_ARN)

PASS=0
FAIL=0

run_check() {
  local label="$1" result="$2"
  if [ "$result" = "pass" ]; then
    info "$label"
    PASS=$((PASS + 1))
  else
    err "$label"
    FAIL=$((FAIL + 1))
  fi
}

# ── DNS Resolution ────────────────────────────────────────────
step "DNS resolution"

DIG_RESULT=$(dig +short CNAME "${FQDN}" 2>/dev/null | head -1 | sed 's/\.$//')
if echo "$DIG_RESULT" | grep -qi "elb.amazonaws.com"; then
  run_check "${FQDN} resolves to ALB" "pass"
else
  run_check "${FQDN} resolves to ALB (got: ${DIG_RESULT:-NXDOMAIN})" "fail"
fi

# ── ALB Target Health ─────────────────────────────────────────
step "Target group health"

TG_HEALTH=$(aws elbv2 describe-target-health \
  --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text)

if [ "$TG_HEALTH" = "healthy" ]; then
  run_check "Target group: healthy" "pass"
else
  run_check "Target group: ${TG_HEALTH} (expected: healthy)" "fail"
  if [ "$TG_HEALTH" = "initial" ]; then
    echo "    Target may still be registering. Wait 30s and rerun."
  fi
fi

# ── HTTPS Connectivity ────────────────────────────────────────
step "HTTPS endpoint checks"

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 "https://${FQDN}/api/status" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  run_check "GET https://${FQDN}/api/status → 200" "pass"
else
  run_check "GET https://${FQDN}/api/status → ${HTTP_CODE} (expected 200)" "fail"
fi

# ── TLS Certificate ───────────────────────────────────────────
step "TLS certificate verification"

CERT_CN=$(echo | openssl s_client -servername "${FQDN}" -connect "${FQDN}:443" 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null | grep -oP "CN\s*=\s*\K.*" || echo "FAILED")

if echo "$CERT_CN" | grep -q "${FQDN}"; then
  run_check "TLS certificate CN matches ${FQDN}" "pass"
else
  run_check "TLS certificate CN: ${CERT_CN} (expected ${FQDN})" "fail"
fi

# ── HTTP → HTTPS Redirect ────────────────────────────────────
step "HTTP → HTTPS redirect"

REDIRECT_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 "http://${FQDN}/" 2>/dev/null || echo "000")

if [ "$REDIRECT_CODE" = "301" ]; then
  run_check "HTTP → HTTPS redirect (301)" "pass"
else
  run_check "HTTP redirect: ${REDIRECT_CODE} (expected 301)" "fail"
fi

# ── Security Headers ──────────────────────────────────────────
step "Security headers"

HEADERS=$(curl -s -I --max-time 10 "https://${FQDN}/api/status" 2>/dev/null)

for HEADER in "x-content-type-options" "x-frame-options" "content-security-policy" \
  "referrer-policy" "strict-transport-security"; do
  if echo "$HEADERS" | grep -qi "$HEADER"; then
    run_check "Header: $HEADER present" "pass"
  else
    run_check "Header: $HEADER MISSING" "fail"
  fi
done

# ── HSTS (production only) ────────────────────────────────────
HSTS_VAL=$(echo "$HEADERS" | grep -i "strict-transport-security" | head -1)
if echo "$HSTS_VAL" | grep -q "max-age=31536000"; then
  run_check "HSTS max-age=31536000" "pass"
else
  run_check "HSTS max-age check (got: ${HSTS_VAL:-MISSING})" "fail"
fi

# ── Auth0 Login Flow ─────────────────────────────────────────
step "Auth0 login redirect"

AUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 -L --max-redirs 0 \
  "https://${FQDN}/auth/login" 2>/dev/null || echo "000")

if [ "$AUTH_CODE" = "302" ]; then
  AUTH_LOCATION=$(curl -s -I --max-time 10 \
    "https://${FQDN}/auth/login" 2>/dev/null \
    | grep -i "^location:" | head -1)
  if echo "$AUTH_LOCATION" | grep -qi "auth0.com"; then
    run_check "Auth0 login redirect → auth0.com" "pass"
  else
    run_check "Auth0 login redirect target (got: ${AUTH_LOCATION})" "fail"
  fi
else
  run_check "Auth0 login redirect (status: ${AUTH_CODE}, expected 302)" "fail"
fi

# ── Application Status ────────────────────────────────────────
step "Application status response"

STATUS_JSON=$(curl -s --max-time 10 "https://${FQDN}/api/status" 2>/dev/null)

AUTH_REQ=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('authRequired','MISSING'))" 2>/dev/null || echo "PARSE_ERROR")
if [ "$AUTH_REQ" = "True" ] || [ "$AUTH_REQ" = "true" ]; then
  run_check "authRequired: true (production mode)" "pass"
else
  run_check "authRequired: ${AUTH_REQ} (expected true in production)" "fail"
fi

# ── PM2 Process ───────────────────────────────────────────────
step "PM2 process status"

SSH="ssh -i ${KEY_PATH} -o StrictHostKeyChecking=no ec2-user@${EIP_PUBLIC}"
PM2_STATUS=$($SSH "pm2 jlist" 2>/dev/null | python3 -c \
  "import sys,json; apps=json.load(sys.stdin); print(apps[0]['pm2_env']['status'] if apps else 'NONE')" 2>/dev/null || echo "UNKNOWN")

if [ "$PM2_STATUS" = "online" ]; then
  run_check "PM2 process: online" "pass"
else
  run_check "PM2 process: ${PM2_STATUS} (expected online)" "fail"
fi

# ── Summary ───────────────────────────────────────────────────
banner "Verification Results"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  ✓ All checks passed. Deployment is live at:"
  echo ""
  echo "    https://${FQDN}"
  echo ""
  echo "  Update Auth0 dashboard if not already done:"
  echo "    Allowed Callback URLs: https://${FQDN}/auth/callback"
  echo "    Allowed Logout URLs:   https://${FQDN}"
  echo "    Allowed Web Origins:   https://${FQDN}"
else
  echo "  ⚠ ${FAIL} check(s) failed. Review above and fix before going live."
fi

echo ""
echo "  Useful commands:"
echo "    SSH:       ssh -i ${KEY_PATH} ec2-user@${EIP_PUBLIC}"
echo "    PM2 logs:  ssh -i ${KEY_PATH} ec2-user@${EIP_PUBLIC} 'pm2 logs'"
echo "    Restart:   ssh -i ${KEY_PATH} ec2-user@${EIP_PUBLIC} 'cd linkedin-agent && pm2 restart linkedin-agent'"
echo "    Redeploy:  ssh -i ${KEY_PATH} ec2-user@${EIP_PUBLIC} 'cd linkedin-agent && git pull && npm ci && npm run build_js && pm2 restart linkedin-agent'"
