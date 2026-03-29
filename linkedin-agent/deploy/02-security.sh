#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 2: Security Groups + Key Pair + IAM Role
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 2: Security Groups + Key Pair + IAM Role"

VPC_ID=$(require_state VPC_ID)

# ── ALB Security Group ────────────────────────────────────────
step "Creating ALB security group (HTTPS from anywhere)"

ALB_SG_ID=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-alb-sg" \
  --description "ALB - HTTPS inbound from internet" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text \
  --tag-specifications "$(make_tags security-group alb-sg)")

aws ec2 authorize-security-group-ingress \
  --group-id "$ALB_SG_ID" \
  --protocol tcp --port 443 \
  --cidr "0.0.0.0/0" > /dev/null

# Also allow HTTP for redirect to HTTPS
aws ec2 authorize-security-group-ingress \
  --group-id "$ALB_SG_ID" \
  --protocol tcp --port 80 \
  --cidr "0.0.0.0/0" > /dev/null

save_state ALB_SG_ID "$ALB_SG_ID"
info "ALB SG: $ALB_SG_ID (443 + 80 from 0.0.0.0/0)"

# ── EC2 Security Group ───────────────────────────────────────
step "Creating EC2 security group (app from ALB, SSH from you)"

EC2_SG_ID=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-ec2-sg" \
  --description "EC2 - app port from ALB, SSH restricted" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text \
  --tag-specifications "$(make_tags security-group ec2-sg)")

# App port from ALB security group only
aws ec2 authorize-security-group-ingress \
  --group-id "$EC2_SG_ID" \
  --protocol tcp --port "$APP_PORT" \
  --source-group "$ALB_SG_ID" > /dev/null

# SSH from specified CIDR
aws ec2 authorize-security-group-ingress \
  --group-id "$EC2_SG_ID" \
  --protocol tcp --port 22 \
  --cidr "$SSH_ALLOWED_CIDR" > /dev/null

save_state EC2_SG_ID "$EC2_SG_ID"
info "EC2 SG: $EC2_SG_ID (${APP_PORT} from ALB, 22 from ${SSH_ALLOWED_CIDR})"

# ── SSH Key Pair ──────────────────────────────────────────────
step "Generating SSH key pair"

KEY_DIR="$(dirname "$0")/keys"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

# Generate locally, then import to AWS (gives us the private key)
ssh-keygen -t ed25519 -f "${KEY_DIR}/${KEY_NAME}" -N "" -C "${PROJECT}-deploy" -q

aws ec2 import-key-pair \
  --key-name "$KEY_NAME" \
  --public-key-material "fileb://${KEY_DIR}/${KEY_NAME}.pub" \
  --tag-specifications "$(make_tags key-pair key)" > /dev/null

chmod 600 "${KEY_DIR}/${KEY_NAME}"
chmod 644 "${KEY_DIR}/${KEY_NAME}.pub"

save_state KEY_NAME "$KEY_NAME"
save_state KEY_PATH "${KEY_DIR}/${KEY_NAME}"
info "Key pair: $KEY_NAME"
info "Private key: ${KEY_DIR}/${KEY_NAME}"
warn "Back up your private key. It cannot be regenerated."

# ── IAM Role for EC2 ─────────────────────────────────────────
step "Creating IAM role for EC2 (SSM + CloudWatch)"

# Trust policy — allows EC2 to assume this role
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

aws iam create-role \
  --role-name "${PROJECT}-ec2-role" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --tags "Key=Project,Value=${PROJECT}" "Key=Environment,Value=${ENV_TAG}" > /dev/null

# Attach managed policies for SSM Session Manager and CloudWatch
aws iam attach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

aws iam attach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"

# Create instance profile and attach role
aws iam create-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" > /dev/null

aws iam add-role-to-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" \
  --role-name "${PROJECT}-ec2-role"

save_state IAM_ROLE "${PROJECT}-ec2-role"
save_state INSTANCE_PROFILE "${PROJECT}-ec2-profile"
info "IAM role: ${PROJECT}-ec2-role"
info "Instance profile: ${PROJECT}-ec2-profile"

# IAM is eventually consistent — wait for propagation
echo "  Waiting 10s for IAM propagation..."
sleep 10

# ── Summary ───────────────────────────────────────────────────
banner "Phase 2 Complete"
echo "  ALB SG:     $ALB_SG_ID"
echo "  EC2 SG:     $EC2_SG_ID"
echo "  Key pair:   $KEY_NAME"
echo "  Private key: ${KEY_DIR}/${KEY_NAME}"
echo "  IAM role:   ${PROJECT}-ec2-role"
echo ""
echo "  Next: bash 03-certificate.sh"
