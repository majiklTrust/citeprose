#!/usr/bin/env bash
# =================================================================
# scripts/tests/test-item1-phase3.sh
# TDD impact suite for delivery 4.25111.40 (Item #1, Phase 3,
# restarted lineage; suite revision 4.25111.44)
# =================================================================
# Run this suite TWICE on devenv: once BEFORE installing 4.25111.40
# (PHASE=before, baseline 4.25111.31 plus the 4.25111.38
# provider-error delivery) and once AFTER (PHASE=after).
#
# 4.25111.43 corrections, from a devenv run of the .39 revision:
#   TC-7 assumed every preview crosses to the Model Provider four
#   times, but a tenant with corroboration DISABLED legitimately
#   crosses three (no corroboration call, so no corroboration spend
#   row: 3 truthful rows failed the fixed >=4 expectation). The case
#   now reads the tenant's corroboration toggle and judges the
#   ledger against the configuration it measured, in both
#   directions: enabled requires the corroboration row, disabled
#   forbids it.
#   TC-6 skipped with "0 samples; tick too fast to judge" and no
#   why: a tick that declines to generate answers in under a second,
#   and the DECLINE REASON is knowable only from the tick's own
#   record, never from the suite's guesswork (4.25111.44: the .43
#   revision's skip line presumed one cause; it now defers entirely
#   to the trail). The skip prints the tick's activity-trail rows so
#   the decline explains itself.
#   TC-1's probe line printed doubled zeros for marker-less files
#   (grep -c prints 0 AND exits nonzero, so the || echo 0 fallback
#   appended a second zero). Counts are normalized; verdicts were
#   never affected.
#
# PROVIDER-AWARE VERDICTS (4.25111.39): when a run is refused by the
# Model Provider itself, the response now carries a PROVIDER_* code
# (or a blocked reason naming the provider failure). Those cases are
# reported as SKIP with the provider's own explanation printed: an
# unfunded or revoked key is an environment fact the suite names,
# never a silent generic failure, and never an application verdict. Each case declares its expected color per phase:
#
#   IMPACT cases     red on the baseline, green after the delivery.
#                    In PHASE=before a red result is EXPECTED and is
#                    reported as EXPECTED-RED.
#   INVARIANT cases  green in BOTH phases.
#
# What Phase 3 changed, and what this suite measures: PRODUCTION
# generation (the preview route, the scheduler tick, force-cycle)
# used to hold one open Postgres transaction on one pinned pool
# client for the run's entire wall time. 4.25111.32 moves them to
# the leased envelope: pg_stat_activity DURING a preview shows the
# same signature the Phase 2 suite showed for the Lab.
#
#   before  a session sits 'idle in transaction' through every
#           provider wait and its transaction ages to the run length
#   after   zero idle-in-transaction sessions and no transaction
#           older than a lease (bounded by XACT_AGE_LIMIT_MS)
#
# COST WARNING: this suite executes REAL production generations on
# the TENANT's own key (previews and force-cycle bill the tenant,
# not the platform). Worst case with every window enabled:
#   1 preview (TC-2 sampling)
#   PREVIEW_CAP_EXPECT+1 previews (TC-3 cap; the baseline accepts
#   and PAYS for every one; SKIP_CAP=1 omits this window)
#   1 force-cycle generation (TC-6; SKIP_FORCE_CYCLE=1 omits it)
# It refuses to start unless RUN_PAID=1. Measured spend is summed
# from the spend ledger at the end.
#
# LINKEDIN SAFETY: force-cycle in mode=auto would PUBLISH the
# generated post to LinkedIn. The suite reads the tenant's stored
# mode first and runs TC-6 ONLY when mode is 'manual' (the tick
# then queues for approval and never touches LinkedIn). Any other
# mode SKIPs TC-6 and says why.
#
# Environment:
#   PHASE        REQUIRED: before | after
#   RUN_PAID     REQUIRED: must be 1 (acknowledges paid runs)
#   BASE_URL     default http://localhost:3001
#   LA_SESSION   file (cwd or beside this script) holding the
#                __la_session cookie VALUE of a live platform-admin
#                session; rolling window, run promptly. COOKIE env
#                (COOKIE='__la_session=<v>') overrides the file.
#   ORIGIN       optional Origin header for the dev bypass
#   CURL_ARGS    optional extra curl arguments (space-free only)
#   TENANT_ID    default: homeTenantId from GET /lab/meta
#   TOPIC_ID     default: first topic from /lab/meta (pinned so a
#                thin-material topic cannot end a preview early and
#                skew the concurrency window)
#   ANGLE        optional angle for the preview body
#   SAMPLE_EVERY_S      sampling cadence while runs are in flight
#                       (default 2)
#   XACT_AGE_LIMIT_MS   oldest mid-run transaction the after phase
#                       tolerates (default 2500)
#   PREVIEW_CAP_EXPECT  the server's PREVIEW_MAX_CONCURRENT_RUNS
#                       (default 3); TC-3 fires this plus one
#   SKIP_CAP=1          omit the TC-3 concurrency window (saves
#                       PREVIEW_CAP_EXPECT+1 paid runs)
#   SKIP_FORCE_CYCLE=1  omit the TC-6 force-cycle generation
#   APP_ROOT     application repo root; auto-detected
#
# Requirements: bash, curl, jq; DB probes use
# `node scripts/dbshell.mjs psql` and SKIP when unavailable.
# Quiet-window assumption: the sampler reads pg_stat_activity for
# the whole database; run when nothing else is using it.
#
# Tracing: every boundary prints CALL >> with the exact URL
# immediately before each request is sent and CALL << with curated
# exit conditions; every case prints its COND contract first. No
# cookie material, no prompt or post content, tenant ids shortened.
# =================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://localhost:3001}"
LAB="$BASE_URL/api/platform-admin/lab"
PHASE="${PHASE:-}"
SAMPLE_EVERY_S="${SAMPLE_EVERY_S:-2}"
XACT_AGE_LIMIT_MS="${XACT_AGE_LIMIT_MS:-2500}"
PREVIEW_CAP_EXPECT="${PREVIEW_CAP_EXPECT:-3}"
JAR=""
EXTRA=()
req() { curl -sS --max-time 900 ${CURL_ARGS:-} "${EXTRA[@]}" "$@"; }

app_root_ok() { [ -f "$1/src/routes/api.js" ]; }
if [ -n "${APP_ROOT:-}" ]; then
  app_root_ok "$APP_ROOT" || { echo "APP_ROOT=$APP_ROOT does not contain the application"; exit 2; }
else
  for cand in "$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)" "$PWD" "$PWD/linkedin-agent"; do
    if [ -n "$cand" ] && app_root_ok "$cand"; then APP_ROOT="$cand"; break; fi
  done
  [ -n "${APP_ROOT:-}" ] || { echo "Could not locate the application root; set APP_ROOT=/path/to/linkedin-agent"; exit 2; }
fi

PASS=0; FAIL=0; SKIP=0; EXPECTED_RED=0; WARN=0
TMPDIR_T="$(mktemp -d /tmp/test-item1-phase3.XXXXXX)"
trap 'rm -rf "$TMPDIR_T"' EXIT
JAR="$TMPDIR_T/cookies.txt"
BASE_HOST="$(printf '%s' "$BASE_URL" | sed -E 's|^[a-z]+://||; s|[:/].*$||')"
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

# Cookie fingerprint (4.25111.39): the first 8 hash characters of the
# session value, printed at start and end, so a rotated or edited
# cookie is VISIBLE in the output instead of silently authenticating
# as an older generation. Never the value itself.
cookie_fp() { printf '%s' "${1:-}" | sha256sum 2>/dev/null | cut -c1-8; }
# Hash the VALUE only, on both ends: the start reading strips the
# name= prefix so it compares against the jar's value column.
if [ -n "${COOKIE:-}" ]; then COOKIE_FP_START="$(cookie_fp "${COOKIE#*=}")"; else COOKIE_FP_START="none"; fi


say()    { printf '%s\n' "$*"; }
metric() { printf 'METRIC %s=%s\n' "$1" "$2"; }
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
      WARN=$((WARN+1)); say "  WARN         $id $desc  (already green on the baseline; is 4.25111.32 already installed?)"
    else
      EXPECTED_RED=$((EXPECTED_RED+1)); say "  EXPECTED-RED $id $desc  $detail"
    fi
  fi
}
skip() { SKIP=$((SKIP+1)); say "  SKIP         $1 $2"; }
c_in()  { say "  CALL >>      $*"; }
c_out() { say "  CALL <<      $*"; }
cond()  { say "  COND         $1 success: $2 | failure: $3"; }
tshort() { printf '%s' "${1:0:8}"; }

[ "$PHASE" = "before" ] || [ "$PHASE" = "after" ] || { say "PHASE must be 'before' or 'after'"; exit 2; }
[ "${RUN_PAID:-}" = "1" ] || { say "REFUSED: this suite makes PAID production runs on the TENANT key. Set RUN_PAID=1 to acknowledge."; exit 2; }
command -v jq >/dev/null || { say "jq is required"; exit 2; }
command -v curl >/dev/null || { say "curl is required"; exit 2; }

say "== test-item1-phase3: PHASE=$PHASE BASE_URL=$BASE_URL sample_every=${SAMPLE_EVERY_S}s xact_age_limit=${XACT_AGE_LIMIT_MS}ms preview_cap_expect=$PREVIEW_CAP_EXPECT app_root=$APP_ROOT =="

# ── Auth preflight ──────────────────────────────────────────────
AUTH_MODE="none"
if [ -n "${COOKIE:-}" ]; then
  if [ -n "$LA_SESSION_PATH" ]; then AUTH_MODE="cookie(LA_SESSION file)"; else AUTH_MODE="cookie(env)"; fi
fi
c_in "GET $BASE_URL/api/platform-admin/tenants auth=$AUTH_MODE cookie_fp=$COOKIE_FP_START origin=${ORIGIN:-none}"
PRE_CODE="$(req -o "$TMPDIR_T/preflight.json" -w '%{http_code}' "$BASE_URL/api/platform-admin/tenants" 2>/dev/null || echo 000)"
c_out "GET $BASE_URL/api/platform-admin/tenants http=$PRE_CODE"
if [ "$PRE_CODE" != "200" ]; then
  say "FATAL: auth preflight to /api/platform-admin/tenants returned HTTP $PRE_CODE"
  head -c 300 "$TMPDIR_T/preflight.json" 2>/dev/null; say ""
  case "$PRE_CODE" in
    401)
      if [ -n "$LA_SESSION_PATH" ]; then
        say "The session cookie in $LA_SESSION_PATH was REFUSED: it is stale"
        say "(rolling window, 5 minutes by default). Copy a FRESH __la_session"
        say "value from an authenticated platform-admin browser tab into"
        say "LA_SESSION and rerun promptly."
      else
        say "The server wants authentication. Put the __la_session value of an"
        say "authenticated platform-admin browser session in a file named"
        say "LA_SESSION in the directory you run from, and rerun promptly."
      fi ;;
    403) say "Authenticated, but not a platform admin (PLATFORM_ADMIN_SUBS)." ;;
    000) say "No response: is the server up at $BASE_URL?" ;;
  esac
  exit 2
fi

# ── Setup: tenant id from lab meta; DB probe; stored mode ───────
c_in "GET $LAB/meta (no tenantId: resolve the caller home tenant)"
META="$(req "$LAB/meta" || true)"
if ! printf '%s' "$META" | jq -e '.tenantId' >/dev/null 2>&1; then
  say "FATAL: GET $LAB/meta did not return metadata; cannot resolve the tenant."
  printf '%s\n' "$META" | head -3
  exit 2
fi
c_out "GET $LAB/meta http=200 homeTenant=$(tshort "$(printf '%s' "$META" | jq -r '.homeTenantId // .tenantId')")"
TENANT_ID="${TENANT_ID:-$(printf '%s' "$META" | jq -r '.homeTenantId // .tenantId')}"
TOPIC_ID="${TOPIC_ID:-$(printf '%s' "$META" | jq -r '.topics[0].id // ""')}"
say "   tenant=$TENANT_ID topic=${TOPIC_ID:-auto} angle='${ANGLE:-}'"

DBSHELL="node $APP_ROOT/scripts/dbshell.mjs"
DB_OK=0
c_in "dbshell.mjs verify (decrypt PG env in memory, connect, no shell)"
if (cd "$APP_ROOT" && $DBSHELL verify >/dev/null 2>&1); then DB_OK=1; fi
c_out "dbshell.mjs verify ok=$DB_OK"
# Tenant-scoped probes (4.25111.35, corrected 4.25111.36): dbshell
# connects as the app user, and the tenant tables are FORCE RLS, so a
# probe that does not set app.current_tenant_id sees ZERO rows and
# updates ZERO rows. Every tenant-scoped statement below therefore
# opens with SET app.current_tenant_id in the same psql session. SET,
# not SELECT set_config(): set_config RETURNS the value as a result
# row, and .35's probes glued that row onto their own readings
# (mode read 'manual' became '<tenant-id>manual', counts grew a
# prefix), failing TC cases against healthy data. SET prints nothing.
# grep -vx: real psql prints a bare SET command tag for the tenant
# GUC prefix even under -t (4.25111.37; the .36 smoke used a mock
# that never emitted it, which is how it shipped unseen).
psql_one() { (cd "$APP_ROOT" && $DBSHELL psql -X -A -t -c "$1" 2>&1) | grep -vx 'SET'; }

STORED_MODE="unknown"
STORED_CORR="unknown"
if [ "$DB_OK" = "1" ]; then
  c_in "psql SELECT agent_state.mode tenant=$(tshort "$TENANT_ID") (LinkedIn safety gate for TC-6)"
  STORED_MODE="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT value FROM agent_state WHERE tenant_id = '$TENANT_ID' AND key = 'mode';" | tr -d '[:space:]')"
  c_out "psql SELECT mode=${STORED_MODE:-unset}"
  # 4.25111.43: the corroboration toggle DECIDES how many Model
  # Provider crossings a preview makes (4 enabled, 3 disabled: no
  # corroboration call, no corroboration spend row), so TC-7 must
  # judge the ledger against the measured configuration. Only the
  # exact value 'disabled' disables; absent means enabled (the
  # application's own default).
  c_in "psql SELECT agent_state.corroboration tenant=$(tshort "$TENANT_ID") (crossing count for TC-7)"
  STORED_CORR="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT value FROM agent_state WHERE tenant_id = '$TENANT_ID' AND key = 'corroboration';" | tr -d '[:space:]')"
  [ "$STORED_CORR" = "disabled" ] || STORED_CORR="enabled"
  c_out "psql SELECT corroboration=$STORED_CORR"
fi

# The combined sampler: idle-in-transaction count and oldest
# in-flight transaction age, this database only, sampler excluded.
SAMPLE_SQL="SELECT coalesce(count(*) FILTER (WHERE state = 'idle in transaction'), 0)::text || '|' || coalesce(max(extract(epoch from (now() - xact_start)) * 1000) FILTER (WHERE xact_start IS NOT NULL AND state <> 'idle'), 0)::bigint::text || '|' || coalesce((SELECT left(regexp_replace(a2.query, '''[^'']*''', '?', 'g'), 70) FROM pg_stat_activity a2 WHERE a2.datname = current_database() AND a2.pid <> pg_backend_pid() AND a2.xact_start IS NOT NULL AND a2.state <> 'idle' ORDER BY a2.xact_start LIMIT 1), '-') FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();"


# When a run fails, the route logs the true cause as an api_error row
# in platform_log (platform-wide, not under RLS). Print every
# error-level entry from the last five minutes (4.25111.36: the
# api_error-only filter missed failures logged under other events) so an HTTP 500 arrives with its reason attached
# (4.25111.35).
dump_api_errors() {
  [ "$DB_OK" = "1" ] || return 0
  c_in "psql SELECT recent error rows: platform_log (all events) and the tenant activity trail"
  psql_one "SELECT to_char(created_at, 'HH24:MI:SS') || ' ' || level || ' ' || event || ' ' || coalesce(detail::text, '') FROM platform_log WHERE level IN ('error', 'warn') AND created_at > now() - interval '5 minutes' ORDER BY id DESC LIMIT 6;" \
    | head -12 | while IFS= read -r line; do [ -n "$line" ] && say "  API_ERROR    $line"; done
  # The activity trail persisted the truth even on the day
  # platform_log was dark; read it too (4.25111.39).
  psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT to_char(timestamp, 'HH24:MI:SS') || ' ' || action || ' ' || coalesce(details->>'errorClass', '-') || ' ' || left(coalesce(details->>'error', details->>'reason', ''), 120) FROM activity_log WHERE tenant_id = '$TENANT_ID' AND level = 'error' AND timestamp > now() - interval '5 minutes' ORDER BY id DESC LIMIT 4;" \
    | head -8 | while IFS= read -r line; do [ -n "$line" ] && say "  TRAIL_ERROR  $line"; done
  c_out "psql error dump complete"
}

# A response the Model Provider itself refused (4.25111.38 surfaces
# these as PROVIDER_* codes, or as a blocked reason that names the
# failure). The application behaved correctly; the environment could
# not fund or authorize the call. Reported as a NAMED skip.
provider_refusal() { # $1 = response file; prints the provider note, rc 0 when provider-caused
  local code msg reason
  code="$(jq -r '.code // empty' "$1" 2>/dev/null)"
  case "$code" in PROVIDER_*)
    msg="$(jq -r '.error // ""' "$1" 2>/dev/null)"
    printf '%s' "$code: $msg"
    return 0 ;;
  esac
  reason="$(jq -r '.reason // ""' "$1" 2>/dev/null)"
  case "$reason" in *"Web research unavailable"*)
    printf '%s' "blocked by provider failure: $reason"
    return 0 ;;
  esac
  return 1
}

preview_body() {
  jq -n --arg topic "${TOPIC_ID:-}" --arg angle "${ANGLE:-}" \
    '{topicId: (if $topic == "" then null else $topic end),
      angle:   (if $angle == "" then null else $angle end)}'
}
post_preview() { # $1 = output file; prints the HTTP code
  req -o "$1" -w '%{http_code}' -H 'Content-Type: application/json' \
    -X POST --data "$(preview_body)" "$BASE_URL/api/generate-preview" 2>/dev/null
}
SPEND_T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── TC-1 (impact, free): source markers of 4.25111.32 ───────────
say "== TC-1 source probe =="
cond "TC-1" "all 4.25111.40 markers present (preview and force-cycle routes plus the scheduler cron wrapper on withTenantWorkflow; PREVIEW_BUSY cap in api.js; yield counts research=4 generator=7 publisher=1 legacy=1; leaseLockTimeoutMs in tenant-workflow.js)" "any marker absent"
c_in "probe api.js, scheduler.js, research.js, content-generator.js, linkedin-publisher.js, linkedin-api.js, tenant-workflow.js under $APP_ROOT"
G1=1
# 4.25111.43: grep -c prints "0" AND exits nonzero on a match-less
# file, so the old `|| echo 0` fallback printed a SECOND zero into
# the count ("0\n0" in the probe line). Normalize: take grep's own
# first line, fall back to 0 only when the file is unreadable
# (grep then prints nothing).
mcount() { local c; c="$(grep -c "$1" "$2" 2>/dev/null | head -n 1)"; printf '%s' "${c:-0}"; }
W_API="$(mcount 'withTenantWorkflow(req.tenant.id' "$APP_ROOT/src/routes/api.js")"
[ "$W_API" = "2" ] || G1=0
grep -q '"PREVIEW_BUSY"' "$APP_ROOT/src/routes/api.js" 2>/dev/null || G1=0
grep -q 'withTenantWorkflow(tenant.id' "$APP_ROOT/src/services/scheduler.js" 2>/dev/null || G1=0
YR="$(mcount 'await yieldDb();' "$APP_ROOT/src/services/research.js")"
YC="$(mcount 'await yieldDb();' "$APP_ROOT/src/services/content-generator.js")"
YP="$(mcount 'await yieldDb();' "$APP_ROOT/src/services/linkedin-publisher.js")"
YL="$(mcount 'await yieldDb();' "$APP_ROOT/src/services/linkedin-api.js")"
# Exactly 4 research yields: the restarted lineage ships the two
# .31 crossings plus the corroboration-pause and burst-close yields
# together in 4.25111.40 (the 3-or-4 tolerance was a .32/.34 split
# artifact of the abandoned lineage).
[ "$YR" = "4" ] && [ "$YC" = "7" ] && [ "$YP" = "1" ] && [ "$YL" = "1" ] || G1=0
grep -q 'leaseLockTimeoutMs' "$APP_ROOT/src/db/tenant-workflow.js" 2>/dev/null || G1=0
c_out "probe api_workflows=$W_API yields r=$YR g=$YC pub=$YP legacy=$YL allPresent=$G1"
verdict "TC-1" "4.25111.40 code markers present in the installed tree" "impact" "$G1" "(markers absent)"

# ── TC-2 (impact, paid): ONE preview, sampled while in flight ───
say "== TC-2 paid preview with pg_stat_activity sampling =="
cond "TC-2" "every mid-preview sample shows 0 idle-in-transaction sessions AND oldest in-flight transaction < ${XACT_AGE_LIMIT_MS}ms (quiet window assumed)" "any sample caught an idle-in-transaction session or a transaction aging toward the run length (the baseline envelope)"
RUN_FILE="$TMPDIR_T/preview.json"
c_in "POST $BASE_URL/api/generate-preview tenant=$(tshort "$TENANT_ID") topic=${TOPIC_ID:-auto} (TENANT-key spend)"
T0=$(date +%s%3N)
( post_preview "$RUN_FILE" > "$RUN_FILE.code" ) &
RUN_PID=$!
IIT_MAX=-1; AGE_MAX=-1; SAMPLES=0
LOCK_MS="NA"; LOCK_TO="NA"
if [ "$DB_OK" = "1" ]; then
  sleep 1
  while kill -0 "$RUN_PID" 2>/dev/null && [ "$SAMPLES" -lt 150 ]; do
    OUT="$(psql_one "$SAMPLE_SQL" | tail -n 1)"
    IIT="${OUT%%|*}"; REST="${OUT#*|}"; AGE="${REST%%|*}"; SLOWQ="${REST#*|}"
    case "$IIT$AGE" in *[!0-9]*) OUT="" ;; esac
    if [ -n "$OUT" ]; then
      SAMPLES=$((SAMPLES+1))
      [ "$IIT" -gt "$IIT_MAX" ] && IIT_MAX="$IIT"
      [ "$AGE" -gt "$AGE_MAX" ] && AGE_MAX="$AGE"
      say "  SAMPLE #$SAMPLES idle_in_txn=$IIT oldest_xact_ms=$AGE last_stmt=[$SLOWQ]"
    fi
    if [ "$LOCK_MS" = "NA" ] && [ "$SAMPLES" -ge 1 ]; then
      c_in "psql UPDATE agent_state key=corroboration tenant=$(tshort "$TENANT_ID") lock_timeout=2500ms (preview in flight)"
      TL0=$(date +%s%3N)
      LOCK_OUT="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SET lock_timeout='2500ms'; UPDATE agent_state SET value = value WHERE tenant_id = '$TENANT_ID' AND key = 'corroboration';")"
      TL1=$(date +%s%3N)
      LOCK_MS=$((TL1 - TL0))
      LOCK_TO="no"
      printf '%s' "$LOCK_OUT" | grep -qi 'lock timeout' && LOCK_TO="yes"
      c_out "psql UPDATE elapsed=${LOCK_MS}ms lockTimeout=$LOCK_TO"
    fi
    sleep "$SAMPLE_EVERY_S"
  done
fi
wait "$RUN_PID"
T1=$(date +%s%3N)
PREVIEW_CODE="$(cat "$RUN_FILE.code" 2>/dev/null || echo 000)"
if [ "$PREVIEW_CODE" = "200" ]; then
  c_out "POST /api/generate-preview http=200 blocked=$(jq -r '.blocked // false' "$RUN_FILE") postId=$(jq -r '.postId // "null"' "$RUN_FILE")"
else
  c_out "POST /api/generate-preview http=$PREVIEW_CODE body=$(head -c 160 "$RUN_FILE" 2>/dev/null)"
fi
metric "preview_total_ms" "$((T1 - T0))"
metric "samples" "$SAMPLES"
metric "idle_in_txn_max" "$IIT_MAX"
metric "oldest_xact_ms_max" "$AGE_MAX"
PROVIDER_NOTE="$(provider_refusal "$RUN_FILE" || true)"
if [ "$DB_OK" != "1" ]; then
  skip "TC-2" "dbshell could not connect; sampling unavailable"
elif [ -n "$PROVIDER_NOTE" ]; then
  # The application answered truthfully; the PROVIDER refused the
  # work. Nothing to measure, everything to name (4.25111.39).
  skip "TC-2" "Model Provider refused the run: $PROVIDER_NOTE"
elif [ "$PREVIEW_CODE" != "200" ]; then
  dump_api_errors
  verdict "TC-2" "sampled preview completed" "invariant" 0 "(http=$PREVIEW_CODE; a 402 means the tenant subscription blocks writes, a 403 means the session's role lacks preview_post; see API_ERROR lines above)"
elif [ "$SAMPLES" -lt 2 ]; then
  skip "TC-2" "only $SAMPLES sample(s) landed; run too fast to judge"
elif [ "$IIT_MAX" -eq 0 ] && [ "$AGE_MAX" -lt "$XACT_AGE_LIMIT_MS" ]; then
  verdict "TC-2" "no idle transaction and no long transaction across $SAMPLES samples" "impact" 1
else
  verdict "TC-2" "no idle transaction and no long transaction across $SAMPLES samples" "impact" 0 "(idle_in_txn_max=$IIT_MAX oldest=${AGE_MAX}ms; the baseline holds one transaction for the whole preview)"
fi

# ── TC-3 (invariant): the preview persisted its work ────────────
say "== TC-3 preview draft and trail persisted =="
cond "TC-3" "the preview returned a postId whose row exists, and the tenant wrote activity rows in the window (production trail is NOT suppressed)" "post row missing or zero activity rows"
if [ "$PREVIEW_CODE" = "200" ] && [ "$DB_OK" = "1" ]; then
  PID_VAL="$(jq -r '.postId // empty' "$RUN_FILE")"
  BLOCKED="$(jq -r '.blocked // false' "$RUN_FILE")"
  if [ "$BLOCKED" = "true" ] || [ -z "$PID_VAL" ]; then
    BLOCK_WHY="$(jq -r '.reason // "no reason given"' "$RUN_FILE" 2>/dev/null | head -c 180)"
    skip "TC-3" "preview was blocked; no draft to check. Reason: $BLOCK_WHY"
  else
    c_in "psql SELECT posts row id=$PID_VAL; SELECT count(activity_log) window=10min"
    ROW="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT count(*) FROM posts WHERE id = ${PID_VAL};" | tr -d '[:space:]')"
    ACT="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT count(*) FROM activity_log WHERE tenant_id = '$TENANT_ID' AND timestamp > now() - interval '10 minutes';" | tr -d '[:space:]')"
    c_out "psql posts_row=$ROW activity_rows=$ACT"
    metric "recent_activity_rows" "${ACT:-NA}"
    if [ "$ROW" = "1" ] && [ "${ACT:-0}" -ge 1 ] 2>/dev/null; then
      verdict "TC-3" "draft persisted and activity trail written" "invariant" 1
    else
      verdict "TC-3" "draft persisted and activity trail written" "invariant" 0 "(posts_row=$ROW activity=$ACT)"
    fi
  fi
else
  skip "TC-3" "no successful preview or no DB probe"
fi

# ── TC-7 (invariant): spend ledger shape for the sampled preview
# A successful preview crosses to the Model Provider once per
# pipeline stage, and 4.25111.20 ruled that real spend is always
# recorded, research included. HOW MANY stages is the tenant's own
# configuration (4.25111.43; the .39 revision hard-coded four and
# failed a healthy tenant whose corroboration toggle is off):
#   corroboration enabled   4 crossings (web_search, corroboration,
#                           generation, quality); the corroboration
#                           row is REQUIRED
#   corroboration disabled  3 crossings; a corroboration row would
#                           mean the toggle is not honored, so it is
#                           FORBIDDEN
# Fewer rows than the configuration demands means a crossing class
# is going unrecorded, which is invisible in totals.
say "== TC-7 spend ledger shape (corroboration=$STORED_CORR) =="
if [ "$STORED_CORR" = "disabled" ]; then
  cond "TC-7" "exactly the configured crossings in the ledger: at least 3 spend rows with at least 1 web_search row and NO corroboration row (toggle is off)" "fewer rows, research absent, or a corroboration row despite the disabled toggle"
else
  cond "TC-7" "at least 4 spend rows for the TC-2 preview window with at least 1 web_search row and at least 1 corroboration row" "fewer rows, or a crossing class absent from the ledger"
fi
if [ "$PREVIEW_CODE" = "200" ] && [ "$DB_OK" = "1" ] && [ "$(jq -r '.blocked // false' "$RUN_FILE")" = "false" ]; then
  c_in "psql SELECT llm_spend_events count and per-call breakdown since ${SPEND_T0}"
  SROWS="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT count(*) FROM llm_spend_events WHERE created_at >= '${SPEND_T0}'::timestamptz;" | tr -d '[:space:]')"
  SBREAK="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT coalesce(source_ref->>'call', 'orchestrated') || ':' || status || '=' || count(*) FROM llm_spend_events WHERE created_at >= '${SPEND_T0}'::timestamptz GROUP BY coalesce(source_ref->>'call', 'orchestrated'), status ORDER BY 1;" | tr '\n' ' ')"
  SWEB="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT count(*) FROM llm_spend_events WHERE created_at >= '${SPEND_T0}'::timestamptz AND source_ref->>'call' = 'web_search';" | tr -d '[:space:]')"
  SCORR="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT count(*) FROM llm_spend_events WHERE created_at >= '${SPEND_T0}'::timestamptz AND source_ref->>'call' = 'corroboration';" | tr -d '[:space:]')"
  c_out "psql spend_rows=${SROWS:-NA} corroboration_rows=${SCORR:-NA} breakdown=[${SBREAK:-none}]"
  metric "spend_rows_preview_window" "${SROWS:-NA}"
  metric "spend_rows_web_search" "${SWEB:-NA}"
  metric "spend_rows_corroboration" "${SCORR:-NA}"
  case "$SROWS$SWEB$SCORR" in
    *[!0-9]*) skip "TC-7" "ledger counts unreadable: rows=$SROWS web_search=$SWEB corroboration=$SCORR" ;;
    *)
      if [ "$STORED_CORR" = "disabled" ]; then
        if [ "$SROWS" -ge 3 ] && [ "$SWEB" -ge 1 ] && [ "$SCORR" -eq 0 ]; then
          verdict "TC-7" "ledger matches the 3-crossing configuration, corroboration off ($SBREAK)" "invariant" 1
        elif [ "$SCORR" -ge 1 ]; then
          verdict "TC-7" "ledger matches the 3-crossing configuration, corroboration off" "invariant" 0 "(corroboration_rows=$SCORR despite the disabled toggle; breakdown: $SBREAK)"
        else
          verdict "TC-7" "ledger matches the 3-crossing configuration, corroboration off" "invariant" 0 "(rows=$SROWS web_search=$SWEB breakdown: $SBREAK; a crossing class is not recording)"
        fi
      else
        if [ "$SROWS" -ge 4 ] && [ "$SWEB" -ge 1 ] && [ "$SCORR" -ge 1 ]; then
          verdict "TC-7" "ledger carries all 4 crossing classes ($SBREAK)" "invariant" 1
        else
          verdict "TC-7" "ledger carries all 4 crossing classes" "invariant" 0 "(rows=$SROWS web_search=$SWEB corroboration=$SCORR breakdown: $SBREAK; a crossing class is not recording)"
        fi
      fi ;;
  esac
else
  skip "TC-7" "no successful unblocked preview to audit"
fi

# ── TC-5 (invariant): mid-run settings write ────────────────────
say "== TC-5 mid-run settings write =="
cond "TC-5" "UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the preview ran" "lock_timeout fired or the write took >=1000ms"
if [ "$LOCK_MS" = "NA" ]; then
  skip "TC-5" "no in-flight window captured"
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

# ── TC-4 (impact, paid unless SKIP_CAP=1): the preview seat cap ─
say "== TC-4 preview concurrency cap =="
cond "TC-4" "of $((PREVIEW_CAP_EXPECT+1)) concurrent previews exactly one is refused http=429 code=PREVIEW_BUSY with numeric cap and inFlight, refusal costs nothing" "every preview accepted (all paid on the tenant key), or a refusal with the wrong body"
if [ "${SKIP_CAP:-0}" = "1" ]; then
  skip "TC-4" "SKIP_CAP=1 (saves $((PREVIEW_CAP_EXPECT+1)) paid tenant-key runs)"
else
  PIDS=(); FILES=(); PROV_N=0
  for i in $(seq 0 "$PREVIEW_CAP_EXPECT"); do
    f="$TMPDIR_T/cap_$i.json"; FILES+=("$f")
    c_in "POST $BASE_URL/api/generate-preview #$i tenant=$(tshort "$TENANT_ID") (TENANT-key spend)"
    ( post_preview "$f" > "$f.code" ) &
    PIDS+=($!)
    # No stagger (4.25111.37): with staggered launches a fast-blocked
    # preview can finish and free its seat before the last request
    # arrives, making a WORKING cap look absent. Simultaneous fire
    # guarantees the overlap the case is about.
    sleep 0.05
  done
  for p in "${PIDS[@]}"; do wait "$p"; done
  OK_N=0; BUSY_N=0; BUSY_FILE=""
  CAP_I=0
  for f in "${FILES[@]}"; do
    code="$(cat "$f.code" 2>/dev/null || echo 000)"
    # A provider-refused preview is NOT an accepted seat, whatever
    # the HTTP code: a research-starved run comes back 200 blocked
    # in milliseconds, frees its seat instantly, and would otherwise
    # read as "cap absent" and FAIL the application for the
    # provider's refusal (the .38 lesson applied to this window).
    if PR_NOTE="$(provider_refusal "$f")"; then
      c_out "POST /api/generate-preview #$CAP_I http=$code PROVIDER REFUSAL: $PR_NOTE"
      PROV_N=$((PROV_N+1))
    elif [ "$code" = "200" ]; then
      c_out "POST /api/generate-preview #$CAP_I http=200 blocked=$(jq -r '.blocked // false' "$f") postId=$(jq -r '.postId // "null"' "$f")"
      OK_N=$((OK_N+1))
    elif [ "$code" = "429" ]; then
      c_out "POST /api/generate-preview #$CAP_I http=429 code=$(jq -r '.code // "?"' "$f") inFlight=$(jq -r '.inFlight // "?"' "$f") cap=$(jq -r '.cap // "?"' "$f")"
      BUSY_N=$((BUSY_N+1)); BUSY_FILE="$f"
    else
      c_out "POST /api/generate-preview #$CAP_I http=$code"
    fi
    CAP_I=$((CAP_I+1))
  done
  metric "preview_concurrent_ok" "$OK_N"
  metric "preview_concurrent_busy" "$BUSY_N"
  if [ "$BUSY_N" -ge 1 ]; then
    SHAPE=1
    jq -e '.code == "PREVIEW_BUSY" and (.cap | type == "number") and (.inFlight | type == "number")' "$BUSY_FILE" >/dev/null 2>&1 || SHAPE=0
    verdict "TC-4" "excess preview refused 429 PREVIEW_BUSY with cap fields" "impact" "$SHAPE" "(429 seen, body shape wrong)"
  elif [ "$PROV_N" -ge 1 ] && [ "$OK_N" -eq 0 ]; then
    skip "TC-4" "Model Provider refused all previews ($PROV_N refusals); the cap had nothing to bound. See the PROVIDER REFUSAL lines."
  else
    verdict "TC-4" "excess preview refused 429 PREVIEW_BUSY with cap fields" "impact" 0 "(accepted=$OK_N provider_refused=$PROV_N busy=0; every accepted preview was paid on the tenant key)"
  fi
fi

# ── TC-6 (impact, paid unless skipped; mode-guarded): force-cycle
say "== TC-6 force-cycle on the leased envelope =="
cond "TC-6" "with mode=manual, POST /api/force-cycle returns 200 while mid-run samples show 0 idle-in-transaction and oldest transaction < ${XACT_AGE_LIMIT_MS}ms; the tick queues for approval, never LinkedIn" "long or idle transaction observed (baseline envelope), or the call failed"
if [ "${SKIP_FORCE_CYCLE:-0}" = "1" ]; then
  skip "TC-6" "SKIP_FORCE_CYCLE=1 (saves one paid tenant-key generation)"
elif [ "$STORED_MODE" != "manual" ]; then
  skip "TC-6" "stored mode is '$STORED_MODE', not 'manual': refusing to run force-cycle (mode=auto would PUBLISH to LinkedIn)"
elif [ "$DB_OK" != "1" ]; then
  skip "TC-6" "dbshell unavailable; cannot enforce the LinkedIn safety gate"
else
  FC_FILE="$TMPDIR_T/force.json"
  c_in "POST $BASE_URL/api/force-cycle tenant=$(tshort "$TENANT_ID") topic=${TOPIC_ID:-auto} mode=manual (TENANT-key spend, queues for approval)"
  ( req -o "$FC_FILE" -w '%{http_code}' -H 'Content-Type: application/json' \
      -X POST --data "$(jq -n --arg t "${TOPIC_ID:-}" '{topicId: (if $t == "" then null else $t end)}')" \
      "$BASE_URL/api/force-cycle" 2>/dev/null > "$FC_FILE.code" ) &
  FC_PID=$!
  FC_IIT=-1; FC_AGE=-1; FC_S=0
  sleep 1
  while kill -0 "$FC_PID" 2>/dev/null && [ "$FC_S" -lt 150 ]; do
    OUT="$(psql_one "$SAMPLE_SQL" | tail -n 1)"
    IIT="${OUT%%|*}"; REST="${OUT#*|}"; AGE="${REST%%|*}"; SLOWQ="${REST#*|}"
    case "$IIT$AGE" in *[!0-9]*) OUT="" ;; esac
    if [ -n "$OUT" ]; then
      FC_S=$((FC_S+1))
      [ "$IIT" -gt "$FC_IIT" ] && FC_IIT="$IIT"
      [ "$AGE" -gt "$FC_AGE" ] && FC_AGE="$AGE"
      say "  SAMPLE #$FC_S idle_in_txn=$IIT oldest_xact_ms=$AGE last_stmt=[$SLOWQ]"
    fi
    sleep "$SAMPLE_EVERY_S"
  done
  wait "$FC_PID"
  FC_CODE="$(cat "$FC_FILE.code" 2>/dev/null || echo 000)"
  c_out "POST /api/force-cycle http=$FC_CODE"
  metric "force_cycle_samples" "$FC_S"
  metric "force_cycle_idle_in_txn_max" "$FC_IIT"
  metric "force_cycle_oldest_xact_ms_max" "$FC_AGE"
  if [ "$FC_CODE" != "200" ] && FC_NOTE="$(provider_refusal "$FC_FILE")"; then
    skip "TC-6" "Model Provider refused the cycle: $FC_NOTE"
  elif [ "$FC_CODE" != "200" ]; then
    dump_api_errors
    verdict "TC-6" "force-cycle sampled clean on the leased envelope" "impact" 0 "(http=$FC_CODE; see API_ERROR lines above)"
  elif [ "$FC_S" -lt 2 ]; then
    # 4.25111.43, corrected 4.25111.44: a tick that answers in under
    # a second did not generate; it DECLINED. WHY is not the suite's
    # to presume: the tick writes its own record (a scheduler_waiting
    # or scheduler_skip row with its stated reason), and that record
    # is the only authority. Print it so the skip explains itself
    # instead of shrugging, and instead of guessing.
    c_in "psql SELECT tick trail rows window=2min (why the tick declined)"
    psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT to_char(timestamp, 'HH24:MI:SS') || ' ' || level || ' ' || action || ' ' || left(coalesce(details::text, ''), 140) FROM activity_log WHERE tenant_id = '$TENANT_ID' AND timestamp > now() - interval '2 minutes' ORDER BY id DESC LIMIT 5;" \
      | head -10 | while IFS= read -r line; do [ -n "$line" ] && say "  TICK_TRAIL   $line"; done
    c_out "psql tick trail printed"
    skip "TC-6" "only $FC_S sample(s): the tick answered without generating. The TICK_TRAIL lines above are the tick's own record of why; clear the condition THEY name and rerun to make this case measurable"
  elif [ "$FC_IIT" -eq 0 ] && [ "$FC_AGE" -lt "$XACT_AGE_LIMIT_MS" ]; then
    verdict "TC-6" "force-cycle held no idle and no long transaction across $FC_S samples" "impact" 1
  else
    verdict "TC-6" "force-cycle held no idle and no long transaction" "impact" 0 "(idle_in_txn_max=$FC_IIT oldest=${FC_AGE}ms)"
  fi
fi

# ── Spend summary from the ledger (previews carry no cost body) ─
if [ "$DB_OK" = "1" ]; then
  c_in "psql SELECT sum(cost_estimate_usd) since suite start (tenant-key spend)"
  SPEND="$(psql_one "SET app.current_tenant_id = '$TENANT_ID'; SELECT coalesce(sum(cost_estimate_usd), 0) FROM llm_spend_events WHERE created_at >= '${SPEND_T0}'::timestamptz;" | tr -d '[:space:]')"
  c_out "psql spend_usd=${SPEND:-NA}"
  metric "suite_spend_usd" "${SPEND:-NA}"
fi

END_VAL="$(awk '$6 == "__la_session" {v=$7} END {print v}' "$JAR" 2>/dev/null)"
if [ -n "$END_VAL" ]; then COOKIE_FP_END="$(cookie_fp "$END_VAL")"; else COOKIE_FP_END="none"; fi
say "   cookie_fp start=$COOKIE_FP_START end=$COOKIE_FP_END rotated=$([ "$COOKIE_FP_START" = "$COOKIE_FP_END" ] && echo no || echo yes)"
say ""
say "== SUMMARY: PHASE=$PHASE pass=$PASS expected_red=$EXPECTED_RED warn=$WARN fail=$FAIL skip=$SKIP =="
if [ "$PHASE" = "before" ]; then
  say "   TDD reading: EXPECTED-RED lines are the baseline shapes this suite tracks."
  say "   Install 4.25111.40, rerun with PHASE=after, and every one must appear as PASS."
fi
[ "$FAIL" -eq 0 ] || exit 1
exit 0
