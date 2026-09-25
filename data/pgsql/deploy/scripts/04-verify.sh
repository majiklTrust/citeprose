#!/usr/bin/env bash
#
# 04-verify.sh
#
# Verifies the marketing_ai_instance container is healthy and accepting
# connections. Read-only operations: this script makes no changes.
#
# Run as: ubuntu user.
#
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-marketing_ai_instance}"
POSTGRES_USER="${POSTGRES_USER:-agent_super}"
POSTGRES_DB="${POSTGRES_DB:-linkedin_posting_database}"
EXPECTED_BIND="${EXPECTED_BIND:-127.0.0.1:5432}"

PASS=0
FAIL=0

check() {
    local label="$1"
    local outcome="$2"
    if [[ "$outcome" == "pass" ]]; then
        echo "  [PASS] $label"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] $label"
        FAIL=$((FAIL + 1))
    fi
}

echo "==> Container existence and state"
if podman container exists "$CONTAINER_NAME"; then
    check "container exists" pass
    STATE=$(podman inspect -f '{{.State.Status}}' "$CONTAINER_NAME")
    if [[ "$STATE" == "running" ]]; then
        check "container running (state: $STATE)" pass
    else
        check "container running (state: $STATE)" fail
    fi
else
    check "container exists" fail
    echo "  Cannot continue without container."
    exit 1
fi

echo
echo "==> Resource caps applied"
MEM=$(podman inspect -f '{{.HostConfig.Memory}}' "$CONTAINER_NAME")
CPU=$(podman inspect -f '{{.HostConfig.NanoCpus}}' "$CONTAINER_NAME")
if [[ "$MEM" -gt 0 ]]; then
    check "memory cap set ($((MEM / 1024 / 1024)) MiB)" pass
else
    check "memory cap set" fail
fi
if [[ "$CPU" -gt 0 ]]; then
    check "cpu cap set ($((CPU / 1000000000)).$(( (CPU / 100000000) % 10 )) cores)" pass
else
    check "cpu cap set" fail
fi

echo
echo "==> Port binding (expect ${EXPECTED_BIND})"
PORT_OUTPUT=$(podman port "$CONTAINER_NAME" 5432/tcp 2>/dev/null || true)
echo "  $PORT_OUTPUT"
if [[ "$PORT_OUTPUT" == "$EXPECTED_BIND" ]]; then
    check "bound to ${EXPECTED_BIND} only" pass
else
    check "bound to ${EXPECTED_BIND} only (got: '${PORT_OUTPUT}')" fail
fi

# Defense-in-depth: also confirm the host listener is on localhost only.
echo
echo "==> Host-side listener check (ss)"
SS_OUTPUT=$(ss -tlnH 2>/dev/null | awk '$4 ~ /:5432$/ {print $4}' || true)
echo "  Listeners on port 5432: ${SS_OUTPUT:-<none>}"
if [[ -n "$SS_OUTPUT" ]] && ! echo "$SS_OUTPUT" | grep -qE "^(0\.0\.0\.0|\*|\[?::\]?):5432$"; then
    check "host listener restricted to non-wildcard address" pass
else
    if [[ -z "$SS_OUTPUT" ]]; then
        check "host listener present" fail
    else
        check "host listener restricted to non-wildcard address" fail
    fi
fi

echo
echo "==> Postgres readiness (pg_isready)"
if podman exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    check "pg_isready accepts connections" pass
else
    check "pg_isready accepts connections" fail
fi

echo
echo "==> Application database exists and is owned by superuser"
# Verifies that the image entrypoint created POSTGRES_DB and that the
# superuser owns it. Counts rows from pg_database joined to pg_roles —
# expects exactly 1 row matching the database name and owner.
DB_OWNER=$(podman exec "$CONTAINER_NAME" psql -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT pg_catalog.pg_get_userbyid(d.datdba) FROM pg_catalog.pg_database d WHERE d.datname='${POSTGRES_DB}'" 2>/dev/null || echo "ERR")
echo "  Owner of '${POSTGRES_DB}': ${DB_OWNER}"
if [[ "$DB_OWNER" == "$POSTGRES_USER" ]]; then
    check "database '${POSTGRES_DB}' owned by '${POSTGRES_USER}'" pass
else
    check "database '${POSTGRES_DB}' owned by '${POSTGRES_USER}' (got: '${DB_OWNER}')" fail
fi

echo
echo "==> Application database accepts queries as superuser"
if podman exec "$CONTAINER_NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1" 2>/dev/null | grep -q "^1$"; then
    check "SELECT 1 succeeds against ${POSTGRES_DB}" pass
else
    check "SELECT 1 succeeds against ${POSTGRES_DB}" fail
fi

echo
echo "==> Systemd user unit (boot persistence)"
UNIT_NAME="container-${CONTAINER_NAME}.service"
if systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1; then
    check "systemd user unit enabled" pass
else
    check "systemd user unit enabled" fail
fi

echo
echo "==> Summary: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
