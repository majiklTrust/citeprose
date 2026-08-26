#!/usr/bin/env bash
# =================================================================
# scripts/tests/test-item1-phase2.sh
# TDD impact suite for delivery 4.25111.28 (Item #1, Phase 2)
# =================================================================
# Run this suite TWICE on devenv: once BEFORE installing Phase 2
# (PHASE=before, baseline 4.25111.27-era tree with Phase 1 already
# installed) and once AFTER (PHASE=after, 4.25111.28 plus the
# 4.25111.31 correction that yields on the orchestrated branches). Each case declares its
# expected color per phase, TDD style:
#
#   IMPACT cases     red on the baseline, green after the delivery.
#                    In PHASE=before a red result is EXPECTED and is
#                    reported as EXPECTED-RED: proof the test can
#                    detect the shape it tracks.
#   INVARIANT cases  green in BOTH phases. They guard behavior the
#                    delivery must not change (Phase 1 rulings and
#                    the 4.25111.20 response floor included).
#
# What Phase 2 changed, and what this suite measures: a Lab run used
# to hold ONE open Postgres transaction on one pinned pool client
# for its entire wall time; 4.25111.28 replaces that envelope with
# short read-only leases surrendered before every Model Provider
# crossing. The observable is pg_stat_activity DURING a run:
#
#   before  a session sits 'idle in transaction' through every
#           provider wait, and its transaction age grows to the
#           length of the run.
#   after   zero idle-in-transaction sessions, and no transaction
#           older than a lease (milliseconds, bounded by
#           XACT_AGE_LIMIT_MS).
#
# Every case also emits grep-able "METRIC name=value" lines so the
# two runs can be diffed for the measured impact.
#
# COST WARNING: this suite executes ONE REAL Lab run on the PLATFORM
# key. It refuses to start unless RUN_PAID=1. The measured spend of
# the run is reported at the end.
#
# Environment:
#   PHASE        REQUIRED: before | after
#   RUN_PAID     REQUIRED: must be 1 (acknowledges the paid run)
#   BASE_URL     default http://localhost:3001
#   LA_SESSION   file (in the current directory, or beside this
#                script) holding the __la_session cookie VALUE of a
#                live platform-admin session: browser devtools,
#                Application > Cookies, copy the value into the file
#                and run promptly (the session is a rolling window,
#                default 5 minutes). The suite reads it, stores it
#                in a curl cookie jar, and the jar captures every
#                refreshed cookie the server issues mid-suite.
#   COOKIE       optional override, COOKIE='__la_session=<value>';
#                when set it wins over the LA_SESSION file.
#   ORIGIN       optional Origin header, for servers running the
#                dev bypass (NODE_ENV=dev with DEV_BYPASS_ORIGINS);
#                with the bypass active no COOKIE is needed at all
#   CURL_ARGS    optional extra curl arguments; space-free args
#                only (quoting does not survive expansion), use
#                COOKIE and ORIGIN for headers
#   TENANT_ID    default: homeTenantId from GET /lab/meta
#   TOPIC_ID     default: first topic from /lab/meta
#   ANGLE        default: first angle of that topic
#   PROVIDER     default: meta.current.provider (else anthropic)
#   MODEL        default: meta.current.model
#   SAMPLE_EVERY_S      seconds between pg_stat_activity samples
#                       while the run is in flight (default 2)
#   XACT_AGE_LIMIT_MS   oldest in-flight transaction the after
#                       phase tolerates mid-run (default 2500;
#                       spend-ledger and platform-log writes are
#                       milliseconds, leases must be too)
#   APP_ROOT     the application repo root; auto-detected, override
#                when running from the Testing project checkout
#
# Requirements on devenv: bash, curl, jq. The sampling, lock, and
# activity cases additionally use `node scripts/dbshell.mjs psql`;
# when that preflight fails they SKIP rather than fail.
#
# Quiet-window assumption: the sampler reads pg_stat_activity for
# the WHOLE database, so other traffic (a scheduler tick, another
# operator) can hold transactions that redden TC-2/TC-3 falsely.
# Run in a quiet window; the COND lines restate this.
#
# Tracing: every boundary the suite crosses (HTTP endpoints, the
# dbshell SQL probes, the source probe) prints a CALL >> line with
# entry conditions, the exact URL immediately before each request
# is sent, and a CALL << line with exit conditions. Every test
# prints a COND line stating its success and failure conditions
# before it runs. Values are curated: never the session cookie,
# never prompt or content text, tenant ids shortened.
# =================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://localhost:3001}"
LAB="$BASE_URL/api/platform-admin/lab"
PHASE="${PHASE:-}"
SAMPLE_EVERY_S="${SAMPLE_EVERY_S:-2}"
XACT_AGE_LIMIT_MS="${XACT_AGE_LIMIT_MS:-2500}"
# Requests go through req(): a cookie jar carries the session and
# every refreshed cookie the server issues mid-suite. CURL_ARGS is
# split-expanded, so it is for space-free extras only.
JAR=""
EXTRA=()
req() { curl -sS --max-time 900 ${CURL_ARGS:-} "${EXTRA[@]}" "$@"; }

# APP_ROOT: self-validating. The suite may run from the app repo or
# from the Testing project, so each candidate is checked for the lab
# route file before being trusted. The route file exists in BOTH
# phases; the Phase 2 primitive itself is what TC-1 probes.
app_root_ok() { [ -f "$1/src/routes/platform-admin-lab-api.js" ]; }
if [ -n "${APP_ROOT:-}" ]; then
  app_root_ok "$APP_ROOT" || { echo "APP_ROOT=$APP_ROOT does not contain the application"; exit 2; }
else
  for cand in "$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)" "$PWD" "$PWD/linkedin-agent"; do
    if [ -n "$cand" ] && app_root_ok "$cand"; then APP_ROOT="$cand"; break; fi
  done
  [ -n "${APP_ROOT:-}" ] || { echo "Could not locate the application root; set APP_ROOT=/path/to/linkedin-agent"; exit 2; }
fi

PASS=0; FAIL=0; SKIP=0; EXPECTED_RED=0; WARN=0
SPEND_TOTAL="0"
TMPDIR_T="$(mktemp -d /tmp/test-item1-phase2.XXXXXX)"
trap 'rm -rf "$TMPDIR_T"' EXIT
JAR="$TMPDIR_T/cookies.txt"
BASE_HOST="$(printf '%s' "$BASE_URL" | sed -E 's|^[a-z]+://||; s|[:/].*$||')"
# Session source: COOKIE env wins; otherwise the LA_SESSION file in
# the current directory (or beside this script) supplies the value.
LA_SESSION_PATH=""
for cand in "$PWD/LA_SESSION" "$SCRIPT_DIR/LA_SESSION"; do
  if [ -z "${COOKIE:-}" ] && [ -f "$cand" ]; then LA_SESSION_PATH="$cand"; break; fi
done
if [ -z "${COOKIE:-}" ] && [ -n "$LA_SESSION_PATH" ]; then
  LA_VAL="$(tr -d '[:space:]' < "$LA_SESSION_PATH")"
  case "$LA_VAL" in
    __la_session=*) COOKIE="$LA_VAL" ;;
    "") ;;
    *) COOKIE="__la_session=$LA_VAL" ;;
  esac
fi
if [ -n "${COOKIE:-}" ]; then
  C_NAME="${COOKIE%%=*}"; C_VAL="${COOKIE#*=}"
  printf '# Netscape HTTP Cookie File\n%s\tFALSE\t/\tFALSE\t0\t%s\t%s\n' \
    "$BASE_HOST" "$C_NAME" "$C_VAL" > "$JAR"
else
  : > "$JAR"
fi
EXTRA=( -b "$JAR" -c "$JAR" )
if [ -n "${ORIGIN:-}" ]; then EXTRA+=( -H "Origin: $ORIGIN" ); fi

say()    { printf '%s\n' "$*"; }
metric() { printf 'METRIC %s=%s\n' "$1" "$2"; }

# verdict CASE_ID DESCRIPTION KIND(impact|invariant) GREEN(0|1) [DETAIL]
verdict() {
  local id="$1" desc="$2" kind="$3" green="$4" detail="${5:-}"
  if [ "$kind" = "invariant" ]; then
    if [ "$green" = "1" ]; then PASS=$((PASS+1)); say "  PASS         $id $desc"
    else FAIL=$((FAIL+1)); say "  FAIL         $id $desc  $detail"; fi
    return
  fi
  if [ "$PHASE" = "after" ]; then
    if [ "$green" = "1" ]; then PASS=$((PASS+1)); say "  PASS         $id $desc"
    else FAIL=$((FAIL+1)); say "  FAIL         $id $desc  $detail"; fi
  else
    if [ "$green" = "1" ]; then
      WARN=$((WARN+1)); say "  WARN         $id $desc  (already green on the baseline; is 4.25111.28 already installed?)"
    else
      EXPECTED_RED=$((EXPECTED_RED+1)); say "  EXPECTED-RED $id $desc  $detail"
    fi
  fi
}
skip() { SKIP=$((SKIP+1)); say "  SKIP         $1 $2"; }

# Boundary tracing: one line before each call the suite makes into
# the application (HTTP endpoint, dbshell/SQL, source probe) and one
# after it returns. Curated values only: no cookie material, no
# prompt or post content, tenant ids shortened to 8 chars.
c_in()  { say "  CALL >>      $*"; }
c_out() { say "  CALL <<      $*"; }
# Explicit per-test contract, printed before the case executes.
cond()  { say "  COND         $1 success: $2 | failure: $3"; }
tshort() { printf '%s' "${1:0:8}"; }

# ── Preconditions ───────────────────────────────────────────────
[ "$PHASE" = "before" ] || [ "$PHASE" = "after" ] || { say "PHASE must be 'before' or 'after'"; exit 2; }
[ "${RUN_PAID:-}" = "1" ] || { say "REFUSED: this suite makes a PAID Lab run on the platform key. Set RUN_PAID=1 to acknowledge."; exit 2; }
command -v jq >/dev/null || { say "jq is required"; exit 2; }
command -v curl >/dev/null || { say "curl is required"; exit 2; }

say "== test-item1-phase2: PHASE=$PHASE BASE_URL=$BASE_URL sample_every=${SAMPLE_EVERY_S}s xact_age_limit=${XACT_AGE_LIMIT_MS}ms app_root=$APP_ROOT =="

# ── Auth preflight ──────────────────────────────────────────────
# Fail here with a usable diagnosis, never at the first real case.
AUTH_MODE="none"
if [ -n "${COOKIE:-}" ]; then
  if [ -n "$LA_SESSION_PATH" ]; then AUTH_MODE="cookie(LA_SESSION file)"; else AUTH_MODE="cookie(env)"; fi
fi
c_in "GET $BASE_URL/api/platform-admin/tenants auth=$AUTH_MODE origin=${ORIGIN:-none}"
PRE_CODE="$(req -o "$TMPDIR_T/preflight.json" -w '%{http_code}' "$BASE_URL/api/platform-admin/tenants" 2>/dev/null || echo 000)"
c_out "GET $BASE_URL/api/platform-admin/tenants http=$PRE_CODE"
if [ "$PRE_CODE" != "200" ]; then
  say "FATAL: auth preflight to /api/platform-admin/tenants returned HTTP $PRE_CODE"
  head -c 300 "$TMPDIR_T/preflight.json" 2>/dev/null; say ""
  case "$PRE_CODE" in
    401)
      if [ -n "$LA_SESSION_PATH" ]; then
        say "The session cookie in $LA_SESSION_PATH was REFUSED: it is stale"
        say "(the session is a rolling window, 5 minutes by default)."
        say "Copy a FRESH __la_session value from an authenticated"
        say "platform-admin browser tab into LA_SESSION and rerun promptly."
      else
        say "The server wants authentication. The session cookie needs to"
        say "live in a file named LA_SESSION in the directory you run from:"
        say "copy the __la_session value from an authenticated platform-admin"
        say "browser tab (devtools, Application > Cookies) into LA_SESSION"
        say "and rerun promptly (rolling window, 5 minutes by default)."
        say "Alternative: a server in dev bypass (NODE_ENV=dev,"
        say "DEV_BYPASS_ORIGINS containing $BASE_URL, DEV_BYPASS_SUB listed"
        say "in PLATFORM_ADMIN_SUBS) needs no cookie at all; add"
        say "ORIGIN=<one of DEV_BYPASS_ORIGINS> if your list differs."
      fi ;;
    403)
      say "Authenticated, but this identity is not a platform admin:"
      say "the session's sub must be in PLATFORM_ADMIN_SUBS." ;;
    000)
      say "No response: is the server up at $BASE_URL?" ;;
  esac
  exit 2
fi

# ── Setup from /lab/meta ────────────────────────────────────────
c_in "GET $LAB/meta (no tenantId: resolve the caller home tenant)"
META="$(req "$LAB/meta" || true)"
if printf '%s' "$META" | jq -e '.tenantId' >/dev/null 2>&1; then
  c_out "GET $LAB/meta http=200 tenant=$(tshort "$(printf '%s' "$META" | jq -r '.tenantId')") topics=$(printf '%s' "$META" | jq -r '.topics | length') corroboration=$(printf '%s' "$META" | jq -r '.corroboration') model=$(printf '%s' "$META" | jq -r '.current.model')"
fi
if ! printf '%s' "$META" | jq -e '.tenantId' >/dev/null 2>&1; then
  say "FATAL: GET $LAB/meta did not return lab metadata. Is the server up and the caller a platform admin?"
  printf '%s\n' "$META" | head -3
  exit 2
fi
TENANT_ID="${TENANT_ID:-$(printf '%s' "$META" | jq -r '.homeTenantId // .tenantId')}"
TOPIC_ID="${TOPIC_ID:-$(printf '%s' "$META" | jq -r '.topics[0].id')}"
ANGLE="${ANGLE:-$(printf '%s' "$META" | jq -r '.topics[0].angles[0] // ""')}"
PROVIDER="${PROVIDER:-$(printf '%s' "$META" | jq -r '.current.provider // "anthropic"')}"
MODEL="${MODEL:-$(printf '%s' "$META" | jq -r '.current.model')}"
[ -n "$TOPIC_ID" ] && [ "$TOPIC_ID" != "null" ] || { say "FATAL: no topic available for tenant $TENANT_ID"; exit 2; }
[ -n "$MODEL" ] && [ "$MODEL" != "null" ] || { say "FATAL: no model selection available; set MODEL explicitly"; exit 2; }
say "   tenant=$TENANT_ID topic=$TOPIC_ID angle='$ANGLE' selection=$PROVIDER/$MODEL"

DBSHELL="node $APP_ROOT/scripts/dbshell.mjs"
DB_OK=0
c_in "dbshell.mjs verify (decrypt PG env in memory, connect, no shell)"
if (cd "$APP_ROOT" && $DBSHELL verify >/dev/null 2>&1); then DB_OK=1; fi
c_out "dbshell.mjs verify ok=$DB_OK"
psql_one() { (cd "$APP_ROOT" && $DBSHELL psql -X -A -t -c "$1" 2>&1); }

run_body() {
  jq -n --arg t "$TENANT_ID" --arg topic "$TOPIC_ID" --arg angle "$ANGLE" \
        --arg p "$PROVIDER" --arg m "$MODEL" \
        '{tenantId:$t, topicId:$topic, angle:$angle, genre:"default",
          corroboration:"on", provider:$p, model:$m}'
}
post_run() { # $1 = output file; prints the HTTP code
  req -o "$1" -w '%{http_code}' -H 'Content-Type: application/json' \
    -X POST --data "$(run_body)" "$LAB/run" 2>/dev/null
}
add_spend() {
  local c
  c="$(jq -r '.cost.totals.costEstimateUsd // 0' "$1" 2>/dev/null || echo 0)"
  SPEND_TOTAL="$(awk -v a="$SPEND_TOTAL" -v b="$c" 'BEGIN{printf "%.6f", a+b}')"
}

# ── TC-1 (impact, free): source markers of 4.25111.28 ───────────
say "== TC-1 source probe =="
cond "TC-1" "all four Phase 2 markers present (src/db/tenant-workflow.js exists; the lab route runs withTenantWorkflow read-only; the sentinel rollback envelope is gone; yield points 2 in research.js and 6 in content-generator.js, every crossing yielding on BOTH its wire branches per the 4.25111.31 correction)" "any marker absent"
c_in "probe tenant-workflow.js, platform-admin-lab-api.js, research.js, content-generator.js under $APP_ROOT"
G1=1
[ -f "$APP_ROOT/src/db/tenant-workflow.js" ] || G1=0
grep -q 'withTenantWorkflow(tenantId, { readOnly: true }' "$APP_ROOT/src/routes/platform-admin-lab-api.js" 2>/dev/null || G1=0
if grep -q 'LabRunComplete' "$APP_ROOT/src/routes/platform-admin-lab-api.js" 2>/dev/null; then G1=0; fi
YR="$(grep -c 'await yieldDb();' "$APP_ROOT/src/services/research.js" 2>/dev/null || echo 0)"
YC="$(grep -c 'await yieldDb();' "$APP_ROOT/src/services/content-generator.js" 2>/dev/null || echo 0)"
# 3 and 7 (4.25111.32): the Phase 2 counts were 2 and 6 (each
# crossing yielding on both wire branches per the 4.25111.31
# correction); Phase 3 added one yield before each production
# cooldown pause (research corroboration pause, content-generator
# generation pause), so a paced wait holds no transaction either.
[ "$YR" = "2" ] || [ "$YR" = "3" ] || G1=0
[ "$YC" = "6" ] || [ "$YC" = "7" ] || G1=0
c_out "probe workflowFile=$([ -f "$APP_ROOT/src/db/tenant-workflow.js" ] && echo yes || echo no) yieldDb_research=$YR yieldDb_generator=$YC allPresent=$G1"
verdict "TC-1" "4.25111.28 code markers present in the installed tree" "impact" "$G1" "(markers absent)"

# ── The paid window: ONE run, sampled while in flight ───────────
# The sampler is the heart of this suite. Each sample reads, for
# this database only and excluding the sampler's own backend:
#   iit  sessions in state 'idle in transaction' (the baseline
#        envelope's signature during every provider wait)
#   age  the oldest in-flight transaction, in ms (the baseline's
#        grows to the run length; a lease stays in milliseconds)
SAMPLE_SQL="SELECT coalesce(count(*) FILTER (WHERE state = 'idle in transaction'), 0)::text || '|' || coalesce(max(extract(epoch from (now() - xact_start)) * 1000) FILTER (WHERE xact_start IS NOT NULL AND state <> 'idle'), 0)::bigint::text FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();"

say "== paid window: one run, pg_stat_activity sampled every ${SAMPLE_EVERY_S}s =="
STORED_CORR_BEFORE="$(printf '%s' "$META" | jq -r '.corroboration')"
RUN_FILE="$TMPDIR_T/run.json"
c_in "POST $LAB/run tenant=$(tshort "$TENANT_ID") topic=$TOPIC_ID corroboration=on selection=$PROVIDER/$MODEL"
T_RUN0=$(date +%s%3N)
( post_run "$RUN_FILE" > "$RUN_FILE.code" ) &
RUN_PID=$!

IIT_MAX=-1; AGE_MAX=-1; SAMPLES=0
LOCK_MS="NA"; LOCK_TO="NA"
if [ "$DB_OK" = "1" ]; then
  sleep 1
  while kill -0 "$RUN_PID" 2>/dev/null && [ "$SAMPLES" -lt 150 ]; do
    OUT="$(psql_one "$SAMPLE_SQL" | tr -d '[:space:]')"
    IIT="${OUT%%|*}"; AGE="${OUT##*|}"
    case "$IIT$AGE" in *[!0-9]*) OUT="" ;; esac
    if [ -n "$OUT" ]; then
      SAMPLES=$((SAMPLES+1))
      [ "$IIT" -gt "$IIT_MAX" ] && IIT_MAX="$IIT"
      [ "$AGE" -gt "$AGE_MAX" ] && AGE_MAX="$AGE"
      say "  SAMPLE #$SAMPLES idle_in_txn=$IIT oldest_xact_ms=$AGE"
    fi
    # One mid-run settings write, once samples prove the run is in
    # flight (Phase 1 ruling: it must land in milliseconds).
    if [ "$LOCK_MS" = "NA" ] && [ "$SAMPLES" -ge 1 ]; then
      c_in "psql UPDATE agent_state key=corroboration tenant=$(tshort "$TENANT_ID") lock_timeout=2500ms (run in flight)"
      T0=$(date +%s%3N)
      LOCK_OUT="$(psql_one "SET lock_timeout='2500ms'; UPDATE agent_state SET value = value WHERE tenant_id = '$TENANT_ID' AND key = 'corroboration';")"
      T1=$(date +%s%3N)
      LOCK_MS=$((T1 - T0))
      LOCK_TO="no"
      printf '%s' "$LOCK_OUT" | grep -qi 'lock timeout' && LOCK_TO="yes"
      c_out "psql UPDATE elapsed=${LOCK_MS}ms lockTimeout=$LOCK_TO"
    fi
    sleep "$SAMPLE_EVERY_S"
  done
fi
wait "$RUN_PID"
T_RUN1=$(date +%s%3N)
RUN_CODE="$(cat "$RUN_FILE.code" 2>/dev/null || echo 000)"
if [ "$RUN_CODE" = "200" ]; then
  c_out "POST /lab/run http=200 blocked=$(jq -r '.result.blocked // false' "$RUN_FILE") stages=$(jq -r '.stages | length' "$RUN_FILE") totalMs=$(jq -r '.totalMs // 0' "$RUN_FILE") costUsd=$(jq -r '.cost.totals.costEstimateUsd // "null"' "$RUN_FILE")"
  add_spend "$RUN_FILE"
else
  c_out "POST /lab/run http=$RUN_CODE"
fi
metric "run_total_ms" "$((T_RUN1 - T_RUN0))"
metric "samples" "$SAMPLES"
metric "idle_in_txn_max" "$IIT_MAX"
metric "oldest_xact_ms_max" "$AGE_MAX"

# ── TC-2 (impact): no idle-in-transaction session mid-run ───────
say "== TC-2 no idle-in-transaction during provider waits =="
cond "TC-2" "every mid-run sample shows 0 idle-in-transaction sessions (quiet window assumed: other traffic can hold transactions of its own)" "any sample caught a session idle in transaction (the baseline envelope parks there through every provider wait)"
if [ "$DB_OK" != "1" ]; then
  skip "TC-2" "dbshell could not connect; sampling unavailable"
elif [ "$SAMPLES" -lt 2 ]; then
  skip "TC-2" "only $SAMPLES sample(s) landed while the run was in flight; run too fast to judge"
elif [ "$IIT_MAX" -eq 0 ]; then
  verdict "TC-2" "zero idle-in-transaction sessions across $SAMPLES mid-run samples" "impact" 1
else
  verdict "TC-2" "zero idle-in-transaction sessions across $SAMPLES mid-run samples" "impact" 0 "(max $IIT_MAX seen; the baseline holds its run transaction through every provider wait)"
fi

# ── TC-3 (impact): no long-lived transaction mid-run ────────────
say "== TC-3 transaction age stays lease-sized =="
cond "TC-3" "oldest in-flight transaction across all samples < ${XACT_AGE_LIMIT_MS}ms (leases, ledger writes, log writes are all milliseconds; quiet window assumed)" "any sample saw a transaction older than ${XACT_AGE_LIMIT_MS}ms (the baseline's single transaction ages to the full run length)"
if [ "$DB_OK" != "1" ]; then
  skip "TC-3" "dbshell could not connect; sampling unavailable"
elif [ "$SAMPLES" -lt 2 ]; then
  skip "TC-3" "only $SAMPLES sample(s); run too fast to judge"
elif [ "$AGE_MAX" -lt "$XACT_AGE_LIMIT_MS" ]; then
  verdict "TC-3" "oldest mid-run transaction ${AGE_MAX}ms < ${XACT_AGE_LIMIT_MS}ms" "impact" 1
else
  verdict "TC-3" "oldest mid-run transaction stays lease-sized" "impact" 0 "(oldest ${AGE_MAX}ms >= ${XACT_AGE_LIMIT_MS}ms; at run length this is the baseline envelope)"
fi

# ── TC-4 (invariant): the run itself succeeds on leases ─────────
say "== TC-4 run success and 4.25111.20 response floor =="
cond "TC-4" "http=200, result present, cost.totals with keySource=platform, numeric totalMs, NO raw trace field" "run failed, or the response floor regressed"
if [ "$RUN_CODE" = "200" ]; then
  G4=1
  jq -e '.result and .cost.totals and (.cost.keySource == "platform") and (.totalMs | type == "number")' "$RUN_FILE" >/dev/null 2>&1 || G4=0
  jq -e 'has("trace") | not' "$RUN_FILE" >/dev/null 2>&1 || G4=0
  verdict "TC-4" "run succeeded under the lease envelope with the .20 response floor" "invariant" "$G4" "(response shape regressed)"
else
  verdict "TC-4" "run succeeded under the lease envelope with the .20 response floor" "invariant" 0 "(http=$RUN_CODE)"
fi

# ── TC-5 (invariant): mid-run settings write in milliseconds ────
# Phase 1's ruling, re-guarded here because Phase 2 replaced the
# transaction machinery around it.
say "== TC-5 mid-run settings write =="
cond "TC-5" "UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the run was in flight" "lock_timeout (2500ms) fired or the write took >=1000ms"
if [ "$LOCK_MS" = "NA" ]; then
  skip "TC-5" "no in-flight window captured for the write probe"
else
  metric "lock_write_ms" "$LOCK_MS"
  if [ "$LOCK_TO" = "yes" ]; then
    verdict "TC-5" "mid-run settings write completes without blocking" "invariant" 0 "(lock_timeout after ${LOCK_MS}ms)"
  elif [ "$LOCK_MS" -lt 1000 ]; then
    verdict "TC-5" "mid-run settings write completes without blocking" "invariant" 1
  else
    verdict "TC-5" "mid-run settings write completes without blocking" "invariant" 0 "(took ${LOCK_MS}ms)"
  fi
fi

# ── TC-6 (invariant): stored corroboration untouched ────────────
say "== TC-6 stored corroboration untouched =="
cond "TC-6" "meta corroboration reads the same value after the forced-on run as before it" "the stored value changed"
c_in "GET $LAB/meta?tenantId=$TENANT_ID (re-read stored corroboration)"
META2="$(req "$LAB/meta?tenantId=$TENANT_ID" || true)"
STORED_CORR_AFTER="$(printf '%s' "$META2" | jq -r '.corroboration')"
c_out "GET /lab/meta corroboration=$STORED_CORR_AFTER (was $STORED_CORR_BEFORE)"
if [ "$STORED_CORR_AFTER" = "$STORED_CORR_BEFORE" ]; then
  verdict "TC-6" "stored corroboration value identical after the forced-on run" "invariant" 1
else
  verdict "TC-6" "stored corroboration value identical after the forced-on run" "invariant" 0 "(was $STORED_CORR_BEFORE, now $STORED_CORR_AFTER)"
fi

# ── TC-7 (invariant): no tenant activity rows from the Lab run ──
say "== TC-7 no activity rows from the Lab run =="
cond "TC-7" "zero activity_log rows for this tenant in the 10 minute window (assumes nothing else used the tenant)" "any rows found (under read-only leases a Lab activity write would have failed the run loudly instead; either way rows here are a ruling breach)"
if [ "$DB_OK" = "1" ]; then
  c_in "psql SELECT count(activity_log) tenant=$(tshort "$TENANT_ID") window=10min"
  RECENT_ACT="$(psql_one "SELECT count(*) FROM activity_log WHERE tenant_id = '$TENANT_ID' AND timestamp > now() - interval '10 minutes';" | tr -d '[:space:]')"
  c_out "psql SELECT count=${RECENT_ACT:-NA}"
  metric "recent_activity_rows" "${RECENT_ACT:-NA}"
  case "$RECENT_ACT" in
    0) verdict "TC-7" "zero activity rows in the run window" "invariant" 1 ;;
    ''|*[!0-9]*) skip "TC-7" "activity count unreadable: $RECENT_ACT" ;;
    *) verdict "TC-7" "zero activity rows in the run window" "invariant" 0 "(found $RECENT_ACT; only valid if nothing else touched this tenant in the last 10 minutes)" ;;
  esac
else
  skip "TC-7" "dbshell could not connect"
fi

# ── Summary ─────────────────────────────────────────────────────
metric "suite_spend_usd" "$SPEND_TOTAL"
say ""
say "== SUMMARY: PHASE=$PHASE pass=$PASS expected_red=$EXPECTED_RED warn=$WARN fail=$FAIL skip=$SKIP spend_estimate_usd=$SPEND_TOTAL =="
if [ "$PHASE" = "before" ]; then
  say "   TDD reading: EXPECTED-RED lines are the baseline shapes this suite tracks."
  say "   Install 4.25111.28, rerun with PHASE=after, and every one must appear as PASS."
fi
[ "$FAIL" -eq 0 ] || exit 1
exit 0
