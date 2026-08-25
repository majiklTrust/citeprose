#!/usr/bin/env bash
# =================================================================
# scripts/tests/test-item1-phase1.sh
# TDD impact suite for delivery 4.25111.21 (Item #1, Phase 1)
# =================================================================
# Run this suite TWICE on devenv: once BEFORE installing 4.25111.21
# (PHASE=before, baseline 4.25111.20) and once AFTER (PHASE=after).
# Each case declares its expected color per phase, TDD style:
#
#   IMPACT cases     red on the baseline, green after the delivery.
#                    In PHASE=before a red result is EXPECTED and is
#                    reported as EXPECTED-RED: proof the test can
#                    detect the defect it tracks.
#   INVARIANT cases  green in BOTH phases. They guard behavior the
#                    delivery must not change.
#
# Every case also emits grep-able "METRIC name=value" lines so the
# two runs can be diffed for the measured impact (lock wait, pause
# gap, spend).
#
# COST WARNING: this suite executes REAL Lab runs on the PLATFORM
# key: CAP_EXPECT paid runs after the delivery, CAP_EXPECT+1 before
# it (the baseline accepts the extra run the cap later refuses). It
# refuses to start unless RUN_PAID=1. The measured spend of every
# successful run is summed and reported at the end.
#
# Environment:
#   PHASE        REQUIRED: before | after
#   RUN_PAID     REQUIRED: must be 1 (acknowledges paid runs)
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
#   COOLDOWN_MS  the server's API_COOLDOWN_MS (default 10000); used
#                only to size the pause-gap expectations
#   CAP_EXPECT   the server's LAB_MAX_CONCURRENT_RUNS (default 2);
#                the suite fires CAP_EXPECT+1 concurrent runs
#   APP_ROOT     the application repo root; auto-detected, override
#                when running from the Testing project checkout
#
# Requirements on devenv: bash, curl, jq. The lock and activity
# cases additionally use `node scripts/dbshell.mjs psql`; when that
# preflight fails they SKIP rather than fail.
#
# Tracing: every boundary the suite crosses (HTTP endpoints, the
# dbshell SQL probes, the source probe) prints a CALL >> line with
# entry conditions and a CALL << line with exit conditions. Every
# test prints a COND line stating its success and failure
# conditions before it runs. Values are curated: never the session
# cookie, never prompt or content text, tenant ids shortened.
# =================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://localhost:3001}"
LAB="$BASE_URL/api/platform-admin/lab"
PHASE="${PHASE:-}"
COOLDOWN_MS="${COOLDOWN_MS:-10000}"
CAP_EXPECT="${CAP_EXPECT:-2}"
# Requests go through req(): a cookie jar carries the session and
# every refreshed cookie the server issues mid-suite. CURL_ARGS is
# split-expanded, so it is for space-free extras only.
JAR=""
EXTRA=()
req() { curl -sS --max-time 900 ${CURL_ARGS:-} "${EXTRA[@]}" "$@"; }

# APP_ROOT: self-validating. The suite may run from the app repo or
# from the Testing project, so each candidate is checked for the lab
# route file before being trusted.
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
TMPDIR_T="$(mktemp -d /tmp/test-item1-phase1.XXXXXX)"
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
      WARN=$((WARN+1)); say "  WARN         $id $desc  (already green on the baseline; is 4.25111.21 already installed?)"
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
[ "${RUN_PAID:-}" = "1" ] || { say "REFUSED: this suite makes PAID Lab runs on the platform key. Set RUN_PAID=1 to acknowledge."; exit 2; }
command -v jq >/dev/null || { say "jq is required"; exit 2; }
command -v curl >/dev/null || { say "curl is required"; exit 2; }

say "== test-item1-phase1: PHASE=$PHASE BASE_URL=$BASE_URL cooldown=${COOLDOWN_MS}ms cap_expect=$CAP_EXPECT app_root=$APP_ROOT =="

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

# ── TC-1 (impact, free): source markers of 4.25111.21 ───────────
say "== TC-1 source probe =="
cond "TC-1" "all three 4.25111.21 markers present (both cooldown predicates gated on labRun(); no setAgentStateInTransaction in the lab route)" "any marker absent"
c_in "grep markers in research.js, content-generator.js, platform-admin-lab-api.js under $APP_ROOT"
G1=1
grep -q '(labRun() || generationVendor()) ? 0 : getCooldownMs()' "$APP_ROOT/src/services/research.js" 2>/dev/null || G1=0
grep -q '(labRun() || generationVendor()) ? 0 : getCooldownMs()' "$APP_ROOT/src/services/content-generator.js" 2>/dev/null || G1=0
if grep -q 'setAgentStateInTransaction' "$APP_ROOT/src/routes/platform-admin-lab-api.js" 2>/dev/null; then G1=0; fi
c_out "grep markers allPresent=$G1"
verdict "TC-1" "4.25111.21 code markers present in the installed tree" "impact" "$G1" "(markers absent)"

# ── The paid window: CAP_EXPECT+1 concurrent runs ───────────────
# One window serves three cases: the cap (TC-2), the mid-run lock
# probe (TC-3), and the pause-gap metric (TC-4) from the first
# successful response.
say "== paid window: firing $((CAP_EXPECT+1)) concurrent runs =="
STORED_CORR_BEFORE="$(printf '%s' "$META" | jq -r '.corroboration')"
PIDS=(); FILES=()
for i in $(seq 0 "$CAP_EXPECT"); do
  f="$TMPDIR_T/run_$i.json"; FILES+=("$f")
  c_in "POST $LAB/run #$i tenant=$(tshort "$TENANT_ID") topic=$TOPIC_ID corroboration=on selection=$PROVIDER/$MODEL"
  ( post_run "$f" > "$f.code" ) &
  PIDS+=($!)
  sleep 0.4
done

# TC-3: while runs are in flight, write the SAME tenant's stored
# corroboration row. The baseline's forced-on run holds a row lock
# on it for the whole run, so this UPDATE hits lock_timeout; after
# 4.25111.21 nothing locks it and the write lands in milliseconds.
say "== TC-3 mid-run settings write =="
cond "TC-3" "UPDATE on the tenant corroboration row returns in <1000ms with no lock timeout while runs are in flight" "lock_timeout (2500ms) fires or the write takes >=1000ms"
sleep 3
if [ "$DB_OK" = "1" ]; then
  c_in "psql UPDATE agent_state key=corroboration tenant=$(tshort "$TENANT_ID") lock_timeout=2500ms (runs in flight)"
  T0=$(date +%s%3N)
  LOCK_OUT="$(psql_one "SET lock_timeout='2500ms'; UPDATE agent_state SET value = value WHERE tenant_id = '$TENANT_ID' AND key = 'corroboration';")"
  T1=$(date +%s%3N)
  LOCK_MS=$((T1 - T0))
  LOCK_TO="no"
  printf '%s' "$LOCK_OUT" | grep -qi 'lock timeout' && LOCK_TO="yes"
  c_out "psql UPDATE elapsed=${LOCK_MS}ms lockTimeout=$LOCK_TO"
  metric "lock_write_ms" "$LOCK_MS"
  if printf '%s' "$LOCK_OUT" | grep -qi 'lock timeout'; then
    verdict "TC-3" "mid-run settings write completes without blocking" "impact" 0 "(lock_timeout after ${LOCK_MS}ms)"
  elif [ "$LOCK_MS" -lt 1000 ]; then
    verdict "TC-3" "mid-run settings write completes without blocking" "impact" 1
  else
    verdict "TC-3" "mid-run settings write completes without blocking" "impact" 0 "(took ${LOCK_MS}ms)"
  fi
else
  skip "TC-3" "dbshell could not connect; lock probe unavailable"
fi

for p in "${PIDS[@]}"; do wait "$p"; done

OK_COUNT=0; BUSY_COUNT=0; FIRST_OK=""; BUSY_FILE=""
RUN_I=0
for f in "${FILES[@]}"; do
  code="$(cat "$f.code" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    c_out "POST /lab/run #$RUN_I http=200 blocked=$(jq -r '.result.blocked // false' "$f") stages=$(jq -r '.stages | length' "$f") totalMs=$(jq -r '.totalMs // 0' "$f") costUsd=$(jq -r '.cost.totals.costEstimateUsd // "null"' "$f")"
    OK_COUNT=$((OK_COUNT+1)); add_spend "$f"
    [ -n "$FIRST_OK" ] || FIRST_OK="$f"
  elif [ "$code" = "429" ]; then
    c_out "POST /lab/run #$RUN_I http=429 code=$(jq -r '.code // "?"' "$f") inFlight=$(jq -r '.inFlight // "?"' "$f") cap=$(jq -r '.cap // "?"' "$f")"
    BUSY_COUNT=$((BUSY_COUNT+1)); BUSY_FILE="$f"
  else
    c_out "POST /lab/run #$RUN_I http=$code"
  fi
  RUN_I=$((RUN_I+1))
done
metric "concurrent_ok" "$OK_COUNT"
metric "concurrent_busy" "$BUSY_COUNT"

# ── TC-2 (impact): the concurrency cap ──────────────────────────
say "== TC-2 concurrency cap =="
cond "TC-2" "exactly the excess concurrent run is refused http=429 code=LAB_BUSY with numeric cap and inFlight" "every run accepted (all paid), or a refusal with the wrong body"
if [ "$BUSY_COUNT" -ge 1 ]; then
  SHAPE=1
  jq -e '.code == "LAB_BUSY" and (.cap | type == "number") and (.inFlight | type == "number")' "$BUSY_FILE" >/dev/null 2>&1 || SHAPE=0
  verdict "TC-2" "excess concurrent run refused 429 LAB_BUSY with cap fields" "impact" "$SHAPE" "(429 seen, body shape wrong)"
else
  verdict "TC-2" "excess concurrent run refused 429 LAB_BUSY with cap fields" "impact" 0 "(all $OK_COUNT runs were accepted; every one was paid)"
fi

# ── TC-4 (impact): the pause gap ────────────────────────────────
# gap = totalMs minus the sum of measured stage durations. On the
# baseline a forced-corroboration run sits through TWO production
# cooldowns inside that gap; after the delivery both are skipped.
say "== TC-4 pause gap =="
cond "TC-4" "totalMs minus the sum of measured stage durations < ${COOLDOWN_MS}ms (both production pauses skipped)" "gap >= ${COOLDOWN_MS}ms (the run sat through at least one production cooldown)"
if [ -n "$FIRST_OK" ]; then
  TOTAL_MS="$(jq -r '.totalMs // 0' "$FIRST_OK")"
  DUR_SUM="$(jq -r '[.stages[]?.durMs // 0] | add // 0' "$FIRST_OK")"
  GAP=$(( ${TOTAL_MS%.*} - ${DUR_SUM%.*} ))
  metric "run_total_ms" "${TOTAL_MS%.*}"
  metric "pause_gap_ms" "$GAP"
  if [ "$GAP" -lt "$COOLDOWN_MS" ]; then
    verdict "TC-4" "unmeasured gap smaller than one cooldown (${GAP}ms < ${COOLDOWN_MS}ms)" "impact" 1
  else
    verdict "TC-4" "unmeasured gap smaller than one cooldown" "impact" 0 "(gap ${GAP}ms, cooldown ${COOLDOWN_MS}ms; the baseline sits through two pauses)"
  fi
else
  skip "TC-4" "no successful run to measure"
fi

# ── TC-5 (invariant): forced choice never changes the stored value
say "== TC-5 stored corroboration untouched =="
cond "TC-5" "meta corroboration reads the same value after forced-on runs as before them" "the stored value changed"
c_in "GET $LAB/meta?tenantId=$TENANT_ID (re-read stored corroboration)"
META2="$(req "$LAB/meta?tenantId=$TENANT_ID" || true)"
STORED_CORR_AFTER="$(printf '%s' "$META2" | jq -r '.corroboration')"
c_out "GET /lab/meta corroboration=$STORED_CORR_AFTER (was $STORED_CORR_BEFORE)"
if [ "$STORED_CORR_AFTER" = "$STORED_CORR_BEFORE" ]; then
  verdict "TC-5" "stored corroboration value identical after forced-on runs" "invariant" 1
else
  verdict "TC-5" "stored corroboration value identical after forced-on runs" "invariant" 0 "(was $STORED_CORR_BEFORE, now $STORED_CORR_AFTER)"
fi

# ── TC-6 (invariant): no tenant activity rows from Lab runs ─────
# Identical end state in both phases BY DESIGN: the baseline rolls
# the rows back, the delivery never writes them. Guards the ruling,
# not the mechanism. Only meaningful when nothing else used this
# tenant during the window; the detail says so.
say "== TC-6 no activity rows from Lab runs =="
cond "TC-6" "zero activity_log rows for this tenant in the 10 minute window (assumes nothing else used the tenant)" "any rows found"
if [ "$DB_OK" = "1" ]; then
  c_in "psql SELECT count(activity_log) tenant=$(tshort "$TENANT_ID") window=10min"
  RECENT_ACT="$(psql_one "SELECT count(*) FROM activity_log WHERE tenant_id = '$TENANT_ID' AND timestamp > now() - interval '10 minutes';" | tr -d '[:space:]')"
  c_out "psql SELECT count=${RECENT_ACT:-NA}"
  metric "recent_activity_rows" "${RECENT_ACT:-NA}"
  case "$RECENT_ACT" in
    0) verdict "TC-6" "zero activity rows in the run window" "invariant" 1 ;;
    ''|*[!0-9]*) skip "TC-6" "activity count unreadable: $RECENT_ACT" ;;
    *) verdict "TC-6" "zero activity rows in the run window" "invariant" 0 "(found $RECENT_ACT; only valid if nothing else touched this tenant in the last 10 minutes)" ;;
  esac
else
  skip "TC-6" "dbshell could not connect"
fi

# ── TC-7 (invariant): the 4.25111.20 response floor holds ───────
say "== TC-7 response floor from 4.25111.20 =="
cond "TC-7" "run response carries cost.totals with keySource=platform and NO raw trace field" "cost missing, attribution not platform, or a trace field present"
if [ -n "$FIRST_OK" ]; then
  G7=1
  jq -e '.cost.totals and (.cost.keySource == "platform")' "$FIRST_OK" >/dev/null 2>&1 || G7=0
  jq -e 'has("trace") | not' "$FIRST_OK" >/dev/null 2>&1 || G7=0
  verdict "TC-7" "cost object present, platform-attributed, no raw trace" "invariant" "$G7"
else
  skip "TC-7" "no successful run to inspect"
fi

# ── Summary ─────────────────────────────────────────────────────
metric "suite_spend_usd" "$SPEND_TOTAL"
say ""
say "== SUMMARY: PHASE=$PHASE pass=$PASS expected_red=$EXPECTED_RED warn=$WARN fail=$FAIL skip=$SKIP paid_runs=$OK_COUNT spend_estimate_usd=$SPEND_TOTAL =="
if [ "$PHASE" = "before" ]; then
  say "   TDD reading: EXPECTED-RED lines are the baseline defects this suite tracks."
  say "   Install 4.25111.21, rerun with PHASE=after, and every one must appear as PASS."
fi
[ "$FAIL" -eq 0 ] || exit 1
exit 0
