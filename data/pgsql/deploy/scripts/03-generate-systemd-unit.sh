#!/usr/bin/env bash
#
# 03-generate-systemd-unit.sh
#
# Generates a systemd user unit from the running marketing_ai_instance container
# and enables it for boot persistence. Requires the container to already be
# running (i.e., 02-bootstrap-postgres.sh has succeeded).
#
# Run as: ubuntu user.
#
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-marketing_ai_instance}"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_NAME="container-${CONTAINER_NAME}.service"

if [[ "$(id -un)" != "ubuntu" ]]; then
    echo "ERROR: must run as ubuntu user" >&2
    exit 1
fi

if ! podman container exists "$CONTAINER_NAME"; then
    echo "ERROR: container '$CONTAINER_NAME' does not exist." >&2
    echo "       Run 02-bootstrap-postgres.sh first." >&2
    exit 1
fi

if ! systemctl --user status >/dev/null 2>&1; then
    echo "ERROR: user systemd not reachable." >&2
    echo "       This usually means linger is not enabled, or you need to" >&2
    echo "       log out and back in after running 01-install-podman.sh." >&2
    echo "       Verify: loginctl show-user \$(id -un) | grep Linger" >&2
    exit 1
fi

echo "==> Creating unit directory: $UNIT_DIR"
mkdir -p "$UNIT_DIR"

echo "==> Generating systemd unit from container '$CONTAINER_NAME'"
cd "$UNIT_DIR"
podman generate systemd --new --name --files "$CONTAINER_NAME"

if [[ ! -f "${UNIT_DIR}/${UNIT_NAME}" ]]; then
    echo "ERROR: expected unit file not generated: ${UNIT_DIR}/${UNIT_NAME}" >&2
    exit 1
fi

echo "==> Reloading user systemd"
systemctl --user daemon-reload

echo "==> Enabling unit for boot start: $UNIT_NAME"
systemctl --user enable "$UNIT_NAME"

echo
echo "==> Verification:"
systemctl --user is-enabled "$UNIT_NAME" || true
echo
echo "==> Phase 3 complete."
echo "    Unit will start the container on boot (linger keeps user systemd alive)."
echo "    To inspect: systemctl --user status $UNIT_NAME"
echo "    To view logs: journalctl --user -u $UNIT_NAME -n 50"
