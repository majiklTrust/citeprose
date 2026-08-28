# 4.25111.x-test-item1-phase3 @ .40
## BEFORE
```
hk_LinkedIn_Agent-development (ubuntu) (4.250111.x/generation-lab/integration-master)
brandonindia-mcs-progress-id_rsa: ***REMOVED***
2026-08-27 13:33 -0500 (CDT) | 18:33:32 UTC development[~/appdev/src/LinkedIn_Agent/linkedin-agent/scripts/tests]
 tests/$ PHASE=before RUN_PAID=1 ./test-item1-phase3.sh
== test-item1-phase3: PHASE=before BASE_URL=http://localhost:3001 sample_every=2s xact_age_limit=2500ms preview_cap_expect=3 app_root=/home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent ==
  CALL >>      GET http://localhost:3001/api/platform-admin/tenants auth=cookie(LA_SESSION file) cookie_fp=80a5b108 origin=none
  CALL <<      GET http://localhost:3001/api/platform-admin/tenants http=200
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta (no tenantId: resolve the caller home tenant)
  CALL <<      GET http://localhost:3001/api/platform-admin/lab/meta http=200 homeTenant=53f2e104
   tenant=53f2e104-4192-439b-abdc-70954bfa9583 topic=ai-practical-benefit angle=''
  CALL >>      dbshell.mjs verify (decrypt PG env in memory, connect, no shell)
  CALL <<      dbshell.mjs verify ok=1
  CALL >>      psql SELECT agent_state.mode tenant=53f2e104 (LinkedIn safety gate for TC-6)
  CALL <<      psql SELECT mode=manual
== TC-1 source probe ==
  COND         TC-1 success: all 4.25111.40 markers present (preview and force-cycle routes plus the scheduler cron wrapper on withTenantWorkflow; PREVIEW_BUSY cap in api.js; yield counts research=4 generator=7 publisher=1 legacy=1; leaseLockTimeoutMs in tenant-workflow.js) | failure: any marker absent
  CALL >>      probe api.js, scheduler.js, research.js, content-generator.js, linkedin-publisher.js, linkedin-api.js, tenant-workflow.js under /home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent
  CALL <<      probe api_workflows=2 yields r=4 g=7 pub=0
0 legacy=0
0 allPresent=0
  EXPECTED-RED TC-1 4.25111.40 code markers present in the installed tree  (markers absent)
== TC-2 paid preview with pg_stat_activity sampling ==
  COND         TC-2 success: every mid-preview sample shows 0 idle-in-transaction sessions AND oldest in-flight transaction < 2500ms (quiet window assumed) | failure: any sample caught an idle-in-transaction session or a transaction aging toward the run length (the baseline envelope)
  CALL >>      POST http://localhost:3001/api/generate-preview tenant=53f2e104 topic=ai-practical-benefit (TENANT-key spend)
  SAMPLE #1 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  CALL >>      psql UPDATE agent_state key=corroboration tenant=53f2e104 lock_timeout=2500ms (preview in flight)
  CALL <<      psql UPDATE elapsed=227ms lockTimeout=no
  SAMPLE #2 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #3 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #4 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #5 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #6 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #7 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #8 idle_in_txn=1 oldest_xact_ms=66 last_stmt=[SELECT value_enc FROM credentials WHERE key = $1]
  SAMPLE #9 idle_in_txn=1 oldest_xact_ms=2267 last_stmt=[SELECT value_enc FROM credentials WHERE key = $1]
  SAMPLE #10 idle_in_txn=1 oldest_xact_ms=325 last_stmt=[SELECT value_enc FROM credentials WHERE key = $1]
  SAMPLE #11 idle_in_txn=1 oldest_xact_ms=2501 last_stmt=[SELECT value_enc FROM credentials WHERE key = $1]
  CALL <<      POST /api/generate-preview http=200 blocked=false postId=1443
METRIC preview_total_ms=25433
METRIC samples=11
METRIC idle_in_txn_max=1
METRIC oldest_xact_ms_max=2501
  EXPECTED-RED TC-2 no idle transaction and no long transaction across 11 samples  (idle_in_txn_max=1 oldest=2501ms; the baseline holds one transaction for the whole preview)
== TC-3 preview draft and trail persisted ==
  COND         TC-3 success: the preview returned a postId whose row exists, and the tenant wrote activity rows in the window (production trail is NOT suppressed) | failure: post row missing or zero activity rows
  CALL >>      psql SELECT posts row id=1443; SELECT count(activity_log) window=10min
  CALL <<      psql posts_row=1 activity_rows=11
METRIC recent_activity_rows=11
  PASS         TC-3 draft persisted and activity trail written
== TC-7 spend ledger shape ==
  COND         TC-7 success: at least 4 spend rows for the TC-2 preview window with at least 1 web_search row (source_ref->>'call' distinguishes research crossings; orchestrated rows carry no call field) | failure: fewer rows, or research crossings absent from the ledger
  CALL >>      psql SELECT llm_spend_events count and per-call breakdown since 2026-08-27T18:33:37Z
  CALL <<      psql spend_rows=3 breakdown=[orchestrated:ok=2 web_search:ok=1 ]
METRIC spend_rows_preview_window=3
METRIC spend_rows_web_search=1
  FAIL         TC-7 ledger carries all crossing classes  (rows=3 web_search=1 breakdown: orchestrated:ok=2 web_search:ok=1 ; a crossing class is not recording)
== TC-5 mid-run settings write ==
  COND         TC-5 success: UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the preview ran | failure: lock_timeout fired or the write took >=1000ms
METRIC lock_write_ms=227
  PASS         TC-5 mid-run settings write completes without blocking
== TC-4 preview concurrency cap ==
  COND         TC-4 success: of 4 concurrent previews exactly one is refused http=429 code=PREVIEW_BUSY with numeric cap and inFlight, refusal costs nothing | failure: every preview accepted (all paid on the tenant key), or a refusal with the wrong body
  CALL >>      POST http://localhost:3001/api/generate-preview #0 tenant=53f2e104 (TENANT-key spend)
  CALL >>      POST http://localhost:3001/api/generate-preview #1 tenant=53f2e104 (TENANT-key spend)
  CALL >>      POST http://localhost:3001/api/generate-preview #2 tenant=53f2e104 (TENANT-key spend)
  CALL >>      POST http://localhost:3001/api/generate-preview #3 tenant=53f2e104 (TENANT-key spend)
  CALL <<      POST /api/generate-preview #0 http=200 blocked=false postId=1445
  CALL <<      POST /api/generate-preview #1 http=200 blocked=false postId=1446
  CALL <<      POST /api/generate-preview #2 http=200 blocked=false postId=1444
  CALL <<      POST /api/generate-preview #3 http=429 code=PREVIEW_BUSY inFlight=3 cap=3
METRIC preview_concurrent_ok=3
METRIC preview_concurrent_busy=1
  WARN         TC-4 excess preview refused 429 PREVIEW_BUSY with cap fields  (already green on the baseline)
== TC-6 force-cycle on the leased envelope ==
  COND         TC-6 success: with mode=manual, POST /api/force-cycle returns 200 while mid-run samples show 0 idle-in-transaction and oldest transaction < 2500ms; the tick queues for approval, never LinkedIn | failure: long or idle transaction observed (baseline envelope), or the call failed
  CALL >>      POST http://localhost:3001/api/force-cycle tenant=53f2e104 topic=ai-practical-benefit mode=manual (TENANT-key spend, queues for approval)
  CALL <<      POST /api/force-cycle http=200
METRIC force_cycle_samples=0
METRIC force_cycle_idle_in_txn_max=-1
METRIC force_cycle_oldest_xact_ms_max=-1
  SKIP         TC-6 only 0 sample(s); tick too fast to judge
  CALL >>      psql SELECT sum(cost_estimate_usd) since suite start (tenant-key spend)
  CALL <<      psql spend_usd=0.152121
METRIC suite_spend_usd=0.152121
   cookie_fp start=80a5b108 end=80a5b108 rotated=no

== SUMMARY: PHASE=before pass=2 expected_red=2 warn=1 fail=1 skip=1 ==
   TDD reading: EXPECTED-RED lines are the baseline shapes this suite tracks.
   Install 4.25111.40, rerun with PHASE=after, and every one must appear as PASS.

```

## AFTER
```
2026-08-27 14:17 -0500 (CDT) | 19:17:30 UTC development[~/appdev/src/LinkedIn_Agent/linkedin-agent/scripts/tests]
 tests/$ PHASE=after RUN_PAID=1 ./test-item1-phase3.sh
== test-item1-phase3: PHASE=after BASE_URL=http://localhost:3001 sample_every=2s xact_age_limit=2500ms preview_cap_expect=3 app_root=/home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent ==
  CALL >>      GET http://localhost:3001/api/platform-admin/tenants auth=cookie(LA_SESSION file) cookie_fp=80a5b108 origin=none
  CALL <<      GET http://localhost:3001/api/platform-admin/tenants http=200
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta (no tenantId: resolve the caller home tenant)
  CALL <<      GET http://localhost:3001/api/platform-admin/lab/meta http=200 homeTenant=53f2e104
   tenant=53f2e104-4192-439b-abdc-70954bfa9583 topic=ai-practical-benefit angle=''
  CALL >>      dbshell.mjs verify (decrypt PG env in memory, connect, no shell)
  CALL <<      dbshell.mjs verify ok=1
  CALL >>      psql SELECT agent_state.mode tenant=53f2e104 (LinkedIn safety gate for TC-6)
  CALL <<      psql SELECT mode=manual
  CALL >>      psql SELECT agent_state.corroboration tenant=53f2e104 (crossing count for TC-7)
  CALL <<      psql SELECT corroboration=disabled
== TC-1 source probe ==
  COND         TC-1 success: all 4.25111.40 markers present (preview and force-cycle routes plus the scheduler cron wrapper on withTenantWorkflow; PREVIEW_BUSY cap in api.js; yield counts research=4 generator=7 publisher=1 legacy=1; leaseLockTimeoutMs in tenant-workflow.js) | failure: any marker absent
  CALL >>      probe api.js, scheduler.js, research.js, content-generator.js, linkedin-publisher.js, linkedin-api.js, tenant-workflow.js under /home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent
  CALL <<      probe api_workflows=2 yields r=4 g=7 pub=1 legacy=1 allPresent=1
  PASS         TC-1 4.25111.40 code markers present in the installed tree
== TC-2 paid preview with pg_stat_activity sampling ==
  COND         TC-2 success: every mid-preview sample shows 0 idle-in-transaction sessions AND oldest in-flight transaction < 2500ms (quiet window assumed) | failure: any sample caught an idle-in-transaction session or a transaction aging toward the run length (the baseline envelope)
  CALL >>      POST http://localhost:3001/api/generate-preview tenant=53f2e104 topic=ai-practical-benefit (TENANT-key spend)
  SAMPLE #1 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  CALL >>      psql UPDATE agent_state key=corroboration tenant=53f2e104 lock_timeout=2500ms (preview in flight)
  CALL <<      psql UPDATE elapsed=232ms lockTimeout=no
  SAMPLE #2 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #3 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #4 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #5 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #6 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #7 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #8 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #9 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #10 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  SAMPLE #11 idle_in_txn=0 oldest_xact_ms=0 last_stmt=[-]
  CALL <<      POST /api/generate-preview http=200 blocked=false postId=1455
METRIC preview_total_ms=25259
METRIC samples=11
METRIC idle_in_txn_max=0
METRIC oldest_xact_ms_max=0
  PASS         TC-2 no idle transaction and no long transaction across 11 samples
== TC-3 preview draft and trail persisted ==
  COND         TC-3 success: the preview returned a postId whose row exists, and the tenant wrote activity rows in the window (production trail is NOT suppressed) | failure: post row missing or zero activity rows
  CALL >>      psql SELECT posts row id=1455; SELECT count(activity_log) window=10min
  CALL <<      psql posts_row=1 activity_rows=79
METRIC recent_activity_rows=79
  PASS         TC-3 draft persisted and activity trail written
== TC-7 spend ledger shape (corroboration=disabled) ==
  COND         TC-7 success: exactly the configured crossings in the ledger: at least 3 spend rows with at least 1 web_search row and NO corroboration row (toggle is off) | failure: fewer rows, research absent, or a corroboration row despite the disabled toggle
  CALL >>      psql SELECT llm_spend_events count and per-call breakdown since 2026-08-27T19:17:38Z
  CALL <<      psql spend_rows=3 corroboration_rows=0 breakdown=[orchestrated:ok=2 web_search:ok=1 ]
METRIC spend_rows_preview_window=3
METRIC spend_rows_web_search=1
METRIC spend_rows_corroboration=0
  PASS         TC-7 ledger matches the 3-crossing configuration, corroboration off (orchestrated:ok=2 web_search:ok=1 )
== TC-5 mid-run settings write ==
  COND         TC-5 success: UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the preview ran | failure: lock_timeout fired or the write took >=1000ms
METRIC lock_write_ms=232
  PASS         TC-5 mid-run settings write completes without blocking
== TC-4 preview concurrency cap ==
  COND         TC-4 success: of 4 concurrent previews exactly one is refused http=429 code=PREVIEW_BUSY with numeric cap and inFlight, refusal costs nothing | failure: every preview accepted (all paid on the tenant key), or a refusal with the wrong body
  CALL >>      POST http://localhost:3001/api/generate-preview #0 tenant=53f2e104 (TENANT-key spend)
  CALL >>      POST http://localhost:3001/api/generate-preview #1 tenant=53f2e104 (TENANT-key spend)
  CALL >>      POST http://localhost:3001/api/generate-preview #2 tenant=53f2e104 (TENANT-key spend)
  CALL >>      POST http://localhost:3001/api/generate-preview #3 tenant=53f2e104 (TENANT-key spend)
  CALL <<      POST /api/generate-preview #0 http=200 blocked=false postId=1456
  CALL <<      POST /api/generate-preview #1 http=200 blocked=false postId=1458
  CALL <<      POST /api/generate-preview #2 http=200 blocked=false postId=1457
  CALL <<      POST /api/generate-preview #3 http=429 code=PREVIEW_BUSY inFlight=3 cap=3
METRIC preview_concurrent_ok=3
METRIC preview_concurrent_busy=1
  PASS         TC-4 excess preview refused 429 PREVIEW_BUSY with cap fields
== TC-6 force-cycle on the leased envelope ==
  COND         TC-6 success: with mode=manual, POST /api/force-cycle returns 200 while mid-run samples show 0 idle-in-transaction and oldest transaction < 2500ms; the tick queues for approval, never LinkedIn | failure: long or idle transaction observed (baseline envelope), or the call failed
  CALL >>      POST http://localhost:3001/api/force-cycle tenant=53f2e104 topic=ai-practical-benefit mode=manual (TENANT-key spend, queues for approval)
  CALL <<      POST /api/force-cycle http=200
METRIC force_cycle_samples=0
METRIC force_cycle_idle_in_txn_max=-1
METRIC force_cycle_oldest_xact_ms_max=-1
  CALL >>      psql SELECT tick trail rows window=2min (why the tick declined)
  TICK_TRAIL   19:18:34 info scheduler_skipped {"raw": "Agent is paused"}
  TICK_TRAIL   19:18:34 info force_cycle {"manual": true, "topicId": "ai-practical-benefit"}
  TICK_TRAIL   19:18:34 info preview_auto_saved {"title": "ROI Measurement Gap in AI Investments", "postId": "1458", "topicId": "ai-practical-benefit"}
  TICK_TRAIL   19:18:32 info preview_auto_saved {"title": "Prompt Engineering as Operational Skill", "postId": "1457", "topicId": "ai-practical-benefit"}
  TICK_TRAIL   19:18:31 info preview_auto_saved {"title": "Small AI wins build org confidence - constrained agents approach", "postId": "1456", "topicId": "ai-practical-benefit"}
  CALL <<      psql tick trail printed
  SKIP         TC-6 only 0 sample(s): the tick answered without generating. The TICK_TRAIL lines above are the tick's own record of why; clear the condition THEY name and rerun to make this case measurable
  CALL >>      psql SELECT sum(cost_estimate_usd) since suite start (tenant-key spend)
  CALL <<      psql spend_usd=0.152869
METRIC suite_spend_usd=0.152869
   cookie_fp start=80a5b108 end=80a5b108 rotated=no

== SUMMARY: PHASE=after pass=6 expected_red=0 warn=0 fail=0 skip=1 ==
```