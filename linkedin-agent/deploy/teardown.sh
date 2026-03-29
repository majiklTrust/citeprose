#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Teardown: Destroy All AWS Resources
# ═══════════════════════════════════════════════════════════════
# Destroys resources in reverse dependency order.
# Safe to run partially — skips resources that don't exist.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "TEARDOWN: Destroying All Resources"

echo "  ⚠  This will PERMANENTLY destroy all resources."
echo "  ⚠  The SQLite database on EC2 will be LOST."
echo ""
read -p "  Type 'destroy' to confirm: " CONFIRM
if [ "$CONFIRM" != "destroy" ]; then
  echo "  Aborted."
  exit 0
fi
echo ""

# ── Helper: safe delete (no error if resource missing) ────────
safe_run() {
  "$@" 2>/dev/null && return 0 || return 0
}

# ── Load Balancer ─────────────────────────────────────────────
step "Removing load balancer"

HTTPS_LISTENER_ARN=$(load_state HTTPS_LISTENER_ARN)
HTTP_LISTENER_ARN=$(load_state HTTP_LISTENER_ARN)
ALB_ARN=$(load_state ALB_ARN)
TG_ARN=$(load_state TG_ARN)

[ -n "$HTTPS_LISTENER_ARN" ] && safe_run aws elbv2 delete-listener --listener-arn "$HTTPS_LISTENER_ARN" && info "HTTPS listener deleted"
[ -n "$HTTP_LISTENER_ARN" ] && safe_run aws elbv2 delete-listener --listener-arn "$HTTP_LISTENER_ARN" && info "HTTP listener deleted"
[ -n "$ALB_ARN" ] && safe_run aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN" && info "ALB deleted"

# Wait for ALB to fully delete before removing target group
if [ -n "$ALB_ARN" ]; then
  echo "  Waiting for ALB deletion to complete..."
  aws elbv2 wait load-balancers-deleted --load-balancer-arns "$ALB_ARN" 2>/dev/null || sleep 30
fi

[ -n "$TG_ARN" ] && safe_run aws elbv2 delete-target-group --target-group-arn "$TG_ARN" && info "Target group deleted"

# ── EC2 Instance ──────────────────────────────────────────────
step "Terminating EC2 instance"

INSTANCE_ID=$(load_state INSTANCE_ID)
EIP_ALLOC=$(load_state EIP_ALLOC)

if [ -n "$EIP_ALLOC" ]; then
  # Disassociate first
  EIP_ASSOC=$(aws ec2 describe-addresses \
    --allocation-ids "$EIP_ALLOC" \
    --query 'Addresses[0].AssociationId' --output text 2>/dev/null || echo "")
  [ -n "$EIP_ASSOC" ] && [ "$EIP_ASSOC" != "None" ] && \
    safe_run aws ec2 disassociate-address --association-id "$EIP_ASSOC"
  safe_run aws ec2 release-address --allocation-id "$EIP_ALLOC" && info "Elastic IP released"
fi

if [ -n "$INSTANCE_ID" ]; then
  safe_run aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" > /dev/null
  info "Instance $INSTANCE_ID terminating"
  echo "  Waiting for termination..."
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" 2>/dev/null || sleep 60
  info "Instance terminated"
fi

# ── Certificate ───────────────────────────────────────────────
step "Deleting ACM certificate"

CERT_ARN=$(load_state CERT_ARN)
[ -n "$CERT_ARN" ] && safe_run aws acm delete-certificate --certificate-arn "$CERT_ARN" && info "Certificate deleted"

# ── Key Pair ──────────────────────────────────────────────────
step "Removing key pair"

safe_run aws ec2 delete-key-pair --key-name "$KEY_NAME" && info "Key pair deleted from AWS"
info "Local key files preserved in keys/ (delete manually if desired)"

# ── IAM ───────────────────────────────────────────────────────
step "Removing IAM role and instance profile"

safe_run aws iam remove-role-from-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" \
  --role-name "${PROJECT}-ec2-role"
safe_run aws iam delete-instance-profile --instance-profile-name "${PROJECT}-ec2-profile" && info "Instance profile deleted"

safe_run aws iam detach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
safe_run aws iam detach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
safe_run aws iam delete-role --role-name "${PROJECT}-ec2-role" && info "IAM role deleted"

# ── Security Groups ───────────────────────────────────────────
step "Removing security groups"

EC2_SG_ID=$(load_state EC2_SG_ID)
ALB_SG_ID=$(load_state ALB_SG_ID)

# Must delete EC2 SG first (it references ALB SG)
[ -n "$EC2_SG_ID" ] && safe_run aws ec2 delete-security-group --group-id "$EC2_SG_ID" && info "EC2 SG deleted"
[ -n "$ALB_SG_ID" ] && safe_run aws ec2 delete-security-group --group-id "$ALB_SG_ID" && info "ALB SG deleted"

# ── Network ───────────────────────────────────────────────────
step "Removing network infrastructure"

RTB_ID=$(load_state RTB_ID)
SUBNET_1_ID=$(load_state SUBNET_1_ID)
SUBNET_2_ID=$(load_state SUBNET_2_ID)
IGW_ID=$(load_state IGW_ID)
VPC_ID=$(load_state VPC_ID)

# Disassociate route table from subnets
if [ -n "$RTB_ID" ]; then
  ASSOCS=$(aws ec2 describe-route-tables --route-table-ids "$RTB_ID" \
    --query 'RouteTables[0].Associations[?!Main].RouteTableAssociationId' --output text 2>/dev/null || echo "")
  for ASSOC in $ASSOCS; do
    safe_run aws ec2 disassociate-route-table --association-id "$ASSOC"
  done
  safe_run aws ec2 delete-route-table --route-table-id "$RTB_ID" && info "Route table deleted"
fi

[ -n "$SUBNET_1_ID" ] && safe_run aws ec2 delete-subnet --subnet-id "$SUBNET_1_ID" && info "Subnet 1 deleted"
[ -n "$SUBNET_2_ID" ] && safe_run aws ec2 delete-subnet --subnet-id "$SUBNET_2_ID" && info "Subnet 2 deleted"

if [ -n "$IGW_ID" ] && [ -n "$VPC_ID" ]; then
  safe_run aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"
  safe_run aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID" && info "Internet gateway deleted"
fi

[ -n "$VPC_ID" ] && safe_run aws ec2 delete-vpc --vpc-id "$VPC_ID" && info "VPC deleted"

# ── CloudWatch ────────────────────────────────────────────────
step "Removing CloudWatch log group"

safe_run aws logs delete-log-group --log-group-name "/linkedin-agent/app" && info "Log group deleted"

# ── State File ────────────────────────────────────────────────
step "Cleaning up state file"

if [ -f "$STATE_FILE" ]; then
  mv "$STATE_FILE" "${STATE_FILE}.destroyed-$(date +%Y%m%d-%H%M%S)"
  info "State file archived"
fi

# ── Summary ───────────────────────────────────────────────────
banner "Teardown Complete"
echo "  All AWS resources destroyed."
echo ""
echo "  Manual cleanup needed:"
echo "  • Remove the CNAME record for ${FQDN} from your DNS provider"
echo "  • Remove the ACM validation CNAME record"
echo "  • Remove the GitHub deploy key from your repository settings"
echo "  • Delete local key files: rm -rf $(dirname "$0")/keys/"
