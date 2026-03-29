#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# EC2 UserData — Bootstrap Script
# ═══════════════════════════════════════════════════════════════
# This runs as root on first boot. It installs Node.js, PM2,
# and prepares the system for the application.
# The application itself is deployed in Phase 6 (via SSH).
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
exec > /var/log/userdata.log 2>&1
echo "=== UserData started at $(date) ==="

# ── System Updates ────────────────────────────────────────────
dnf update -y -q

# ── Node.js 20 LTS ───────────────────────────────────────────
# Amazon Linux 2023 provides nodejs20 in default repos.
# Node 20 is the current LTS — compatible with the application.
dnf install -y -q nodejs20 npm git

# Verify
node --version
npm --version
git --version

# ── PM2 (global) ─────────────────────────────────────────────
npm install -g pm2

# Configure PM2 to start on boot
env PATH=$PATH:/usr/bin pm2 startup systemd -u ec2-user --hp /home/ec2-user
systemctl enable pm2-ec2-user

# ── Application Directory ────────────────────────────────────
APP_DIR="/home/ec2-user/linkedin-agent"
mkdir -p "$APP_DIR"
chown -R ec2-user:ec2-user "$APP_DIR"

# ── CloudWatch Agent ─────────────────────────────────────────
dnf install -y -q amazon-cloudwatch-agent

# CloudWatch agent config — ships PM2 logs
cat > /opt/aws/amazon-cloudwatch-agent/etc/agent-config.json << 'CWEOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/home/ec2-user/.pm2/logs/*-out.log",
            "log_group_name": "/linkedin-agent/app",
            "log_stream_name": "{instance_id}/stdout",
            "retention_in_days": 30
          },
          {
            "file_path": "/home/ec2-user/.pm2/logs/*-error.log",
            "log_group_name": "/linkedin-agent/app",
            "log_stream_name": "{instance_id}/stderr",
            "retention_in_days": 30
          }
        ]
      }
    }
  }
}
CWEOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/agent-config.json -s

# ── Swap (safety net for t3.small 2GB RAM) ────────────────────
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile > /dev/null
  swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

# ── Signal completion ─────────────────────────────────────────
echo "=== UserData completed at $(date) ==="
touch /home/ec2-user/.userdata-complete
chown ec2-user:ec2-user /home/ec2-user/.userdata-complete
