#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# LinkedIn AI Agent — AWS Deployment Configuration
# ═══════════════════════════════════════════════════════════════
# Source this file from all phase scripts:
#   source "$(dirname "$0")/config.sh"
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Region ────────────────────────────────────────────────────
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"

# ── Naming ────────────────────────────────────────────────────
PROJECT="linkedin-agent"
ENV_TAG="production"

# ── Domain ────────────────────────────────────────────────────
DOMAIN="contosorealtime.com"
SUBDOMAIN="agent"
FQDN="${SUBDOMAIN}.${DOMAIN}"

# ── Network ───────────────────────────────────────────────────
VPC_CIDR="10.10.0.0/16"
SUBNET_PUBLIC_1_CIDR="10.10.1.0/24"
SUBNET_PUBLIC_2_CIDR="10.10.2.0/24"
AZ_1="${AWS_REGION}a"
AZ_2="${AWS_REGION}b"

# ── Compute ───────────────────────────────────────────────────
INSTANCE_TYPE="t3.small"
AMI_NAME="al2023-ami-2023*-x86_64"   # Amazon Linux 2023 latest
EBS_SIZE=20                            # GB, gp3
KEY_NAME="${PROJECT}-key"
SSH_ALLOWED_CIDR="0.0.0.0/0"          # CHANGE to your IP/32 after launch

# ── Application ───────────────────────────────────────────────
APP_PORT=3001
GITHUB_REPO=""  # Set this: git@github.com:youruser/yourrepo.git
                # or https://github.com/youruser/yourrepo.git
GITHUB_BRANCH="main"

# ── Tags (applied to all resources) ──────────────────────────
TAG_SPEC="ResourceType=__TYPE__,Tags=[{Key=Name,Value=${PROJECT}-__NAME__},{Key=Project,Value=${PROJECT}},{Key=Environment,Value=${ENV_TAG}}]"

# ── State file ────────────────────────────────────────────────
# Phase scripts write resource IDs here. Subsequent phases read them.
STATE_FILE="$(dirname "$0")/.deploy-state"

save_state() {
  local key="$1" val="$2"
  # Remove existing key if present, then append
  if [ -f "$STATE_FILE" ]; then
    grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
  echo "${key}=${val}" >> "$STATE_FILE"
}

load_state() {
  local key="$1"
  if [ -f "$STATE_FILE" ]; then
    grep "^${key}=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
  fi
}

require_state() {
  local key="$1"
  local val
  val=$(load_state "$key")
  if [ -z "$val" ]; then
    echo "ERROR: Required state '${key}' not found. Run the previous phase first."
    exit 1
  fi
  echo "$val"
}

# ── Tag helper ────────────────────────────────────────────────
make_tags() {
  local type="$1" name="$2"
  echo "${TAG_SPEC//__TYPE__/$type}" | sed "s/__NAME__/$name/g"
}

# ── Logging ───────────────────────────────────────────────────
info()  { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }
err()   { echo "  ✗ $*" >&2; }
step()  { echo ""; echo "── $* ──────────────────────────────────────"; }
banner() {
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  $*"
  echo "═══════════════════════════════════════════════════════════"
  echo ""
}
