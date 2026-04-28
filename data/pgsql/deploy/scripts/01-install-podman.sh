#!/usr/bin/env bash
#
# 01-install-podman.sh
#
# Installs Podman and rootless prerequisites on Ubuntu 22.04, including the
# systemd drop-in that delegates cpu/cpuset/io/memory/pids cgroup controllers
# to the user's systemd slice (required for --cpus and --memory limits in
# rootless containers).
#
# Idempotent: safe to re-run.
#
# Run as: ubuntu user (uses sudo internally for apt and systemd config only).
# This script does NOT pull images, create containers, or write data.
#
set -euo pipefail

if [[ "$(id -un)" != "ubuntu" ]]; then
    echo "ERROR: this script must run as the 'ubuntu' user (current: $(id -un))" >&2
    exit 1
fi

if ! grep -q "Ubuntu 22.04" /etc/os-release; then
    echo "WARNING: this script is tuned for Ubuntu 22.04. Detected:" >&2
    grep PRETTY_NAME /etc/os-release >&2
    echo "Continuing in 5 seconds. Ctrl-C to abort." >&2
    sleep 5
fi

echo "==> Updating apt package index"
sudo apt-get update -qq

echo "==> Installing Podman and rootless dependencies"
sudo apt-get install -y -qq \
    podman \
    uidmap \
    slirp4netns \
    fuse-overlayfs \
    dbus-user-session

echo "==> Verifying Podman installation"
podman --version

echo "==> Checking subuid/subgid mappings for rootless containers"
if ! grep -q "^ubuntu:" /etc/subuid; then
    echo "    Adding subuid mapping for ubuntu user"
    sudo usermod --add-subuids 100000-165535 ubuntu
fi
if ! grep -q "^ubuntu:" /etc/subgid; then
    echo "    Adding subgid mapping for ubuntu user"
    sudo usermod --add-subgids 100000-165535 ubuntu
fi

grep "^ubuntu:" /etc/subuid /etc/subgid

echo "==> Configuring cgroup controller delegation for rootless containers"
DELEGATE_DIR="/etc/systemd/system/user@.service.d"
DELEGATE_FILE="${DELEGATE_DIR}/delegate.conf"
DELEGATE_CONTENT="[Service]
Delegate=cpu cpuset io memory pids"

if [[ -f "$DELEGATE_FILE" ]] && diff -q <(echo "$DELEGATE_CONTENT") "$DELEGATE_FILE" >/dev/null 2>&1; then
    echo "    Drop-in already in place: $DELEGATE_FILE"
else
    echo "    Writing drop-in: $DELEGATE_FILE"
    sudo mkdir -p "$DELEGATE_DIR"
    echo "$DELEGATE_CONTENT" | sudo tee "$DELEGATE_FILE" >/dev/null
    sudo systemctl daemon-reload
fi

echo "==> Enabling user lingering (so user systemd runs without active login)"
sudo loginctl enable-linger "$(id -un)"

echo "==> Verifying user systemd is reachable"
SYSTEMD_USER_OK=0
if systemctl --user status >/dev/null 2>&1; then
    SYSTEMD_USER_OK=1
fi

echo "==> Verifying cgroup controllers delegated to user slice"
USER_CG_FILE="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers"
NEEDS_REBOOT=0
if [[ -f "$USER_CG_FILE" ]]; then
    USER_CONTROLLERS=$(cat "$USER_CG_FILE")
    echo "    Available: $USER_CONTROLLERS"
    if ! echo "$USER_CONTROLLERS" | grep -qw cpu; then
        NEEDS_REBOOT=1
    fi
    if ! echo "$USER_CONTROLLERS" | grep -qw memory; then
        NEEDS_REBOOT=1
    fi
else
    echo "    User cgroup file not yet present (expected on first run before login)."
    NEEDS_REBOOT=1
fi

echo
if [[ "$NEEDS_REBOOT" -eq 1 ]] || [[ "$SYSTEMD_USER_OK" -eq 0 ]]; then
    echo "==> ACTION REQUIRED: reboot before running Phase 2."
    echo "    Reason: cgroup controller delegation and/or user systemd require"
    echo "    a fresh user slice to take effect. After reboot, verify with:"
    echo "      cat $USER_CG_FILE"
    echo "    Expected to include: cpu memory (among others)."
    echo
    echo "    Run: sudo reboot"
    exit 2
fi

echo "==> Phase 1 complete."
echo "    cgroup controllers delegated, user systemd reachable, linger enabled."
echo "    Next: ensure config and bootstrap files are placed under PROJECT_ROOT"
echo "    (default /home/ubuntu/marketing-ai/postgres/) before running"
echo "    02-bootstrap-postgres.sh"
