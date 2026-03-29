#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 4: EC2 Instance + Elastic IP + Target Group
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 4: EC2 Instance + Elastic IP + Target Group"

VPC_ID=$(require_state VPC_ID)
SUBNET_1_ID=$(require_state SUBNET_1_ID)
EC2_SG_ID=$(require_state EC2_SG_ID)

# ── Resolve latest AMI ───────────────────────────────────────
step "Finding latest Amazon Linux 2023 AMI"

AMI_ID=$(aws ec2 describe-images \
  --owners amazon \
  --filters \
    "Name=name,Values=${AMI_NAME}" \
    "Name=architecture,Values=x86_64" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)

if [ "$AMI_ID" = "None" ] || [ -z "$AMI_ID" ]; then
  err "No AMI found matching ${AMI_NAME}"
  exit 1
fi

save_state AMI_ID "$AMI_ID"
info "AMI: $AMI_ID"

# ── Launch EC2 Instance ──────────────────────────────────────
step "Launching EC2 instance (${INSTANCE_TYPE})"

USERDATA_B64=$(base64 -w0 "$(dirname "$0")/userdata.sh")

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$EC2_SG_ID" \
  --subnet-id "$SUBNET_1_ID" \
  --iam-instance-profile "Name=${PROJECT}-ec2-profile" \
  --user-data "$USERDATA_B64" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${EBS_SIZE},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled" \
  --query 'Instances[0].InstanceId' --output text \
  --tag-specifications "$(make_tags instance ec2)" "$(make_tags volume ebs)")

save_state INSTANCE_ID "$INSTANCE_ID"
info "Instance: $INSTANCE_ID"

# ── Wait for running ─────────────────────────────────────────
step "Waiting for instance to reach running state"

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
info "Instance is running"

# ── Elastic IP ────────────────────────────────────────────────
step "Allocating Elastic IP"

EIP_ALLOC=$(aws ec2 allocate-address \
  --domain vpc \
  --query 'AllocationId' --output text \
  --tag-specifications "$(make_tags elastic-ip eip)")

EIP_PUBLIC=$(aws ec2 describe-addresses \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].PublicIp' --output text)

aws ec2 associate-address \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$EIP_ALLOC" > /dev/null

save_state EIP_ALLOC "$EIP_ALLOC"
save_state EIP_PUBLIC "$EIP_PUBLIC"
info "Elastic IP: $EIP_PUBLIC → $INSTANCE_ID"

# ── Target Group ──────────────────────────────────────────────
step "Creating target group (HTTP:${APP_PORT})"

TG_ARN=$(aws elbv2 create-target-group \
  --name "${PROJECT}-tg" \
  --protocol HTTP \
  --port "$APP_PORT" \
  --vpc-id "$VPC_ID" \
  --target-type instance \
  --health-check-path "/api/status" \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text \
  --tags "Key=Name,Value=${PROJECT}-tg" "Key=Project,Value=${PROJECT}")

aws elbv2 register-targets \
  --target-group-arn "$TG_ARN" \
  --targets "Id=${INSTANCE_ID}"

save_state TG_ARN "$TG_ARN"
info "Target group: $TG_ARN"
info "Registered instance $INSTANCE_ID"

# ── Wait for UserData ─────────────────────────────────────────
step "Waiting for UserData bootstrap to complete"

KEY_PATH=$(require_state KEY_PATH)
SSH_CMD="ssh -i ${KEY_PATH} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ec2-user@${EIP_PUBLIC}"

MAX_WAIT=30
WAIT=0
while [ $WAIT -lt $MAX_WAIT ]; do
  if $SSH_CMD "test -f /home/ec2-user/.userdata-complete" 2>/dev/null; then
    info "UserData bootstrap complete"
    break
  fi
  WAIT=$((WAIT + 1))
  echo "  [$WAIT/$MAX_WAIT] Bootstrap in progress... (30s)"
  sleep 30
done

if [ $WAIT -ge $MAX_WAIT ]; then
  warn "Bootstrap did not complete within 15 minutes."
  echo "  Check /var/log/userdata.log on the instance:"
  echo "  $SSH_CMD 'cat /var/log/userdata.log'"
fi

# Verify Node.js is installed
NODE_VER=$($SSH_CMD "node --version" 2>/dev/null || echo "NOT FOUND")
PM2_VER=$($SSH_CMD "pm2 --version" 2>/dev/null || echo "NOT FOUND")
info "Node.js: $NODE_VER"
info "PM2: $PM2_VER"

# ── Summary ───────────────────────────────────────────────────
banner "Phase 4 Complete"
echo "  Instance:     $INSTANCE_ID"
echo "  Elastic IP:   $EIP_PUBLIC"
echo "  AMI:          $AMI_ID"
echo "  Target group: $TG_ARN"
echo "  SSH:          ssh -i ${KEY_PATH} ec2-user@${EIP_PUBLIC}"
echo ""
echo "  Next: bash 05-loadbalancer.sh"
