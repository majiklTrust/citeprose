#!/usr/bin/env bash
#
# 02-bootstrap-postgres.sh
#
# Pulls the postgres:17 image, creates the named volume, and starts the
# marketing_ai_instance container. The image entrypoint creates the
# superuser (POSTGRES_USER) and the application database (POSTGRES_DB) on
# first init. Any *.sh or *.sql files in $PROJECT_ROOT/bootstrap/ are also
# executed on first init by the image entrypoint, in lexical order.
#
# Run as: ubuntu user.
# Prerequisites:
#   - 01-install-podman.sh has been run (and host rebooted if it requested).
#   - $PROJECT_ROOT/configs/postgresql.conf.17.appdev exists.
#   - $PROJECT_ROOT/configs/pg_hba.conf.17.appdev exists.
#   - $PROJECT_ROOT/bootstrap/ exists (may be empty).
#   - $PROJECT_ROOT/.env exists with mode 0600 and contains POSTGRES_PASSWORD.
#
# Idempotency:
#   - If the container exists, the script reports state and exits 0.
#   - To recreate, stop and remove the container manually first.
#
set -euo pipefail

# ---- Parameters (override via environment) -----------------------------------
PROJECT_ROOT="${PROJECT_ROOT:-/home/ubuntu/marketing-ai/postgres}"
CONTAINER_NAME="${CONTAINER_NAME:-marketing_ai_instance}"
IMAGE="${IMAGE:-docker.io/library/postgres:17}"
VOLUME_NAME="${VOLUME_NAME:-pgdata_marketing_ai_application}"
HOST_PORT_BIND="${HOST_PORT_BIND:-127.0.0.1:5432:5432}"
MEMORY_LIMIT="${MEMORY_LIMIT:-4g}"
MEMORY_SWAP="${MEMORY_SWAP:-4g}"
CPU_LIMIT="${CPU_LIMIT:-1.5}"
POSTGRES_USER="${POSTGRES_USER:-***REMOVED***}"
POSTGRES_DB="${POSTGRES_DB:-***REMOVED***}"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"

# ---- Preflight checks --------------------------------------------------------
echo "==> Preflight checks"

if [[ "$(id -un)" != "ubuntu" ]]; then
    echo "ERROR: must run as ubuntu user" >&2
    exit 1
fi

if ! command -v podman >/dev/null 2>&1; then
    echo "ERROR: podman not installed. Run 01-install-podman.sh first." >&2
    exit 1
fi

for f in \
    "${PROJECT_ROOT}/configs/postgresql.conf.17.appdev" \
    "${PROJECT_ROOT}/configs/pg_hba.conf.17.appdev"
do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: required config file missing: $f" >&2
        exit 1
    fi
done

if [[ ! -d "${PROJECT_ROOT}/bootstrap" ]]; then
    echo "WARNING: ${PROJECT_ROOT}/bootstrap/ does not exist." >&2
    echo "         Container will start without an initdb.d mount." >&2
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: env file missing: $ENV_FILE" >&2
    echo "       Create it with mode 0600 containing:" >&2
    echo "         POSTGRES_PASSWORD=<your-password-here>" >&2
    exit 1
fi

ENV_PERMS=$(stat -c '%a' "$ENV_FILE")
if [[ "$ENV_PERMS" != "600" ]]; then
    echo "ERROR: $ENV_FILE has permissions $ENV_PERMS; must be 600" >&2
    echo "       Run: chmod 600 $ENV_FILE" >&2
    exit 1
fi

if ! grep -q "^POSTGRES_PASSWORD=" "$ENV_FILE"; then
    echo "ERROR: $ENV_FILE does not contain POSTGRES_PASSWORD=" >&2
    exit 1
fi

# ---- Idempotency check -------------------------------------------------------
if podman container exists "$CONTAINER_NAME"; then
    STATE=$(podman inspect -f '{{.State.Status}}' "$CONTAINER_NAME")
    echo "==> Container '$CONTAINER_NAME' already exists (state: $STATE)"
    echo "    To recreate: podman stop $CONTAINER_NAME && podman rm $CONTAINER_NAME"
    echo "    Then re-run this script."
    exit 0
fi

# ---- Pull image --------------------------------------------------------------
echo "==> Pulling image: $IMAGE"
podman pull "$IMAGE"

# ---- Create named volume (idempotent) ----------------------------------------
if ! podman volume exists "$VOLUME_NAME"; then
    echo "==> Creating volume: $VOLUME_NAME"
    podman volume create "$VOLUME_NAME"
else
    echo "==> Volume already exists: $VOLUME_NAME"
fi

# ---- Run container -----------------------------------------------------------
echo "==> Starting container: $CONTAINER_NAME"
echo "    Image:        $IMAGE"
echo "    Port bind:    $HOST_PORT_BIND"
echo "    Memory cap:   $MEMORY_LIMIT (swap: $MEMORY_SWAP)"
echo "    CPU cap:      $CPU_LIMIT"
echo "    Volume:       $VOLUME_NAME -> /var/lib/postgresql/data"
echo "    Bootstrap:    ${PROJECT_ROOT}/bootstrap -> /docker-entrypoint-initdb.d (ro)"
echo "    Configs:      ${PROJECT_ROOT}/configs/*.appdev -> /etc/postgresql/ (ro)"
echo "    Superuser:    $POSTGRES_USER"
echo "    Database:     $POSTGRES_DB (owned by $POSTGRES_USER)"

podman run -d \
    --name "$CONTAINER_NAME" \
    --restart=unless-stopped \
    --env-file "$ENV_FILE" \
    -e POSTGRES_USER="$POSTGRES_USER" \
    -e POSTGRES_DB="$POSTGRES_DB" \
    -p "$HOST_PORT_BIND" \
    --memory="$MEMORY_LIMIT" \
    --memory-swap="$MEMORY_SWAP" \
    --cpus="$CPU_LIMIT" \
    -v "${VOLUME_NAME}:/var/lib/postgresql/data" \
    -v "${PROJECT_ROOT}/bootstrap:/docker-entrypoint-initdb.d:ro,Z" \
    -v "${PROJECT_ROOT}/configs/postgresql.conf.17.appdev:/etc/postgresql/postgresql.conf:ro,Z" \
    -v "${PROJECT_ROOT}/configs/pg_hba.conf.17.appdev:/etc/postgresql/pg_hba.conf:ro,Z" \
    "$IMAGE" \
    postgres -c config_file=/etc/postgresql/postgresql.conf

echo
echo "==> Container started. Waiting 5 seconds for initdb..."
sleep 5

echo "==> Container status:"
podman ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "==> Recent logs (last 30 lines):"
podman logs --tail 30 "$CONTAINER_NAME"

echo
echo "==> Phase 2 complete."
echo "    Next: run 03-generate-systemd-unit.sh to enable boot persistence."
