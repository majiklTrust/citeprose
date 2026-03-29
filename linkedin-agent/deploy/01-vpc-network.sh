#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 1: VPC + Network Infrastructure
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 1: VPC + Network Infrastructure"

# ── VPC ───────────────────────────────────────────────────────
step "Creating VPC (${VPC_CIDR})"

VPC_ID=$(aws ec2 create-vpc \
  --cidr-block "$VPC_CIDR" \
  --query 'Vpc.VpcId' --output text \
  --tag-specifications "$(make_tags vpc vpc)")

aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames

save_state VPC_ID "$VPC_ID"
info "VPC: $VPC_ID"

# ── Internet Gateway ─────────────────────────────────────────
step "Creating Internet Gateway"

IGW_ID=$(aws ec2 create-internet-gateway \
  --query 'InternetGateway.InternetGatewayId' --output text \
  --tag-specifications "$(make_tags internet-gateway igw)")

aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"

save_state IGW_ID "$IGW_ID"
info "IGW: $IGW_ID (attached to $VPC_ID)"

# ── Public Subnets ────────────────────────────────────────────
step "Creating public subnets in 2 AZs"

SUBNET_1_ID=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block "$SUBNET_PUBLIC_1_CIDR" \
  --availability-zone "$AZ_1" \
  --query 'Subnet.SubnetId' --output text \
  --tag-specifications "$(make_tags subnet public-1)")

aws ec2 modify-subnet-attribute --subnet-id "$SUBNET_1_ID" --map-public-ip-on-launch

SUBNET_2_ID=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block "$SUBNET_PUBLIC_2_CIDR" \
  --availability-zone "$AZ_2" \
  --query 'Subnet.SubnetId' --output text \
  --tag-specifications "$(make_tags subnet public-2)")

aws ec2 modify-subnet-attribute --subnet-id "$SUBNET_2_ID" --map-public-ip-on-launch

save_state SUBNET_1_ID "$SUBNET_1_ID"
save_state SUBNET_2_ID "$SUBNET_2_ID"
info "Subnet 1: $SUBNET_1_ID ($AZ_1)"
info "Subnet 2: $SUBNET_2_ID ($AZ_2)"

# ── Route Table ───────────────────────────────────────────────
step "Creating route table with internet route"

RTB_ID=$(aws ec2 create-route-table \
  --vpc-id "$VPC_ID" \
  --query 'RouteTable.RouteTableId' --output text \
  --tag-specifications "$(make_tags route-table public-rt)")

aws ec2 create-route \
  --route-table-id "$RTB_ID" \
  --destination-cidr-block "0.0.0.0/0" \
  --gateway-id "$IGW_ID" > /dev/null

aws ec2 associate-route-table --route-table-id "$RTB_ID" --subnet-id "$SUBNET_1_ID" > /dev/null
aws ec2 associate-route-table --route-table-id "$RTB_ID" --subnet-id "$SUBNET_2_ID" > /dev/null

save_state RTB_ID "$RTB_ID"
info "Route table: $RTB_ID (0.0.0.0/0 → $IGW_ID)"

# ── Summary ───────────────────────────────────────────────────
banner "Phase 1 Complete"
echo "  VPC:      $VPC_ID"
echo "  IGW:      $IGW_ID"
echo "  Subnet 1: $SUBNET_1_ID ($AZ_1)"
echo "  Subnet 2: $SUBNET_2_ID ($AZ_2)"
echo "  Route:    $RTB_ID"
echo ""
echo "  Next: bash 02-security.sh"
