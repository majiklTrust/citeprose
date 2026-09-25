# 4.25111.x-test-item1-phase2 pre 4.25111.31
## BEFORE
```bash

2026-08-25 16:17 -0500 (CDT) | 21:17:57 UTC development[~/appdev/src/LinkedIn_Agent/linkedin-agent/scripts/tests]
 tests/$ PHASE=before RUN_PAID=1 ./test-item1-phase2.sh
== test-item1-phase2: PHASE=before BASE_URL=http://localhost:3001 sample_every=2s xact_age_limit=2500ms app_root=/home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent ==
  CALL >>      GET http://localhost:3001/api/platform-admin/tenants auth=cookie(LA_SESSION file) origin=none
  CALL <<      GET http://localhost:3001/api/platform-admin/tenants http=200
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta (no tenantId: resolve the caller home tenant)
  CALL <<      GET http://localhost:3001/api/platform-admin/lab/meta http=200 tenant=53f2e104 topics=13 corroboration=true model=claude-haiku-4-5-20251001
   tenant=53f2e104-4192-439b-abdc-70954bfa9583 topic=ai-practical-benefit angle='Automating a specific business process end-to-end with AI' selection=anthropic/claude-haiku-4-5-20251001
  CALL >>      dbshell.mjs verify (decrypt PG env in memory, connect, no shell)
  CALL <<      dbshell.mjs verify ok=1
== TC-1 source probe ==
  COND         TC-1 success: all four 4.25111.28 markers present (src/db/tenant-workflow.js exists; the lab route runs withTenantWorkflow read-only; the sentinel rollback envelope is gone; five yieldDb crossings: 2 in research.js, 3 in content-generator.js) | failure: any marker absent
  CALL >>      probe tenant-workflow.js, platform-admin-lab-api.js, research.js, content-generator.js under /home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent
  CALL <<      probe workflowFile=no yieldDb_research=0
0 yieldDb_generator=0
0 allPresent=0
  EXPECTED-RED TC-1 4.25111.28 code markers present in the installed tree  (markers absent)
== paid window: one run, pg_stat_activity sampled every 2s ==
  CALL >>      POST http://localhost:3001/api/platform-admin/lab/run tenant=53f2e104 topic=ai-practical-benefit corroboration=on selection=anthropic/claude-haiku-4-5-20251001
  SAMPLE #1 idle_in_txn=1 oldest_xact_ms=1262
  CALL >>      psql UPDATE agent_state key=corroboration tenant=53f2e104 lock_timeout=2500ms (run in flight)
  CALL <<      psql UPDATE elapsed=208ms lockTimeout=no
  SAMPLE #2 idle_in_txn=1 oldest_xact_ms=3714
  SAMPLE #3 idle_in_txn=1 oldest_xact_ms=5901
  SAMPLE #4 idle_in_txn=1 oldest_xact_ms=8089
  SAMPLE #5 idle_in_txn=1 oldest_xact_ms=10273
  SAMPLE #6 idle_in_txn=1 oldest_xact_ms=12434
  SAMPLE #7 idle_in_txn=1 oldest_xact_ms=14634
  SAMPLE #8 idle_in_txn=1 oldest_xact_ms=16817
  SAMPLE #9 idle_in_txn=1 oldest_xact_ms=19012
  SAMPLE #10 idle_in_txn=1 oldest_xact_ms=21195
  SAMPLE #11 idle_in_txn=1 oldest_xact_ms=23419
  SAMPLE #12 idle_in_txn=1 oldest_xact_ms=25612
  SAMPLE #13 idle_in_txn=1 oldest_xact_ms=27812
  SAMPLE #14 idle_in_txn=1 oldest_xact_ms=29997
  SAMPLE #15 idle_in_txn=1 oldest_xact_ms=32186
  SAMPLE #16 idle_in_txn=1 oldest_xact_ms=34368
  CALL <<      POST /lab/run http=200 blocked=false stages=14 totalMs=34957 costUsd=0.042891
METRIC run_total_ms=36468
METRIC samples=16
METRIC idle_in_txn_max=1
METRIC oldest_xact_ms_max=34368
== TC-2 no idle-in-transaction during provider waits ==
  COND         TC-2 success: every mid-run sample shows 0 idle-in-transaction sessions (quiet window assumed: other traffic can hold transactions of its own) | failure: any sample caught a session idle in transaction (the baseline envelope parks there through every provider wait)
  EXPECTED-RED TC-2 zero idle-in-transaction sessions across 16 mid-run samples  (max 1 seen; the baseline holds its run transaction through every provider wait)
== TC-3 transaction age stays lease-sized ==
  COND         TC-3 success: oldest in-flight transaction across all samples < 2500ms (leases, ledger writes, log writes are all milliseconds; quiet window assumed) | failure: any sample saw a transaction older than 2500ms (the baseline's single transaction ages to the full run length)
  EXPECTED-RED TC-3 oldest mid-run transaction stays lease-sized  (oldest 34368ms >= 2500ms; at run length this is the baseline envelope)
== TC-4 run success and 4.25111.20 response floor ==
  COND         TC-4 success: http=200, result present, cost.totals with keySource=platform, numeric totalMs, NO raw trace field | failure: run failed, or the response floor regressed
  PASS         TC-4 run succeeded under the lease envelope with the .20 response floor
== TC-5 mid-run settings write ==
  COND         TC-5 success: UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the run was in flight | failure: lock_timeout (2500ms) fired or the write took >=1000ms
METRIC lock_write_ms=208
  PASS         TC-5 mid-run settings write completes without blocking
== TC-6 stored corroboration untouched ==
  COND         TC-6 success: meta corroboration reads the same value after the forced-on run as before it | failure: the stored value changed
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta?tenantId=53f2e104-4192-439b-abdc-70954bfa9583 (re-read stored corroboration)
  CALL <<      GET /lab/meta corroboration=true (was true)
  PASS         TC-6 stored corroboration value identical after the forced-on run
== TC-7 no activity rows from the Lab run ==
  COND         TC-7 success: zero activity_log rows for this tenant in the 10 minute window (assumes nothing else used the tenant) | failure: any rows found (under read-only leases a Lab activity write would have failed the run loudly instead; either way rows here are a ruling breach)
  CALL >>      psql SELECT count(activity_log) tenant=53f2e104 window=10min
  CALL <<      psql SELECT count=0
METRIC recent_activity_rows=0
  PASS         TC-7 zero activity rows in the run window
METRIC suite_spend_usd=0.042891

== SUMMARY: PHASE=before pass=4 expected_red=3 warn=0 fail=0 skip=0 spend_estimate_usd=0.042891 ==
   TDD reading: EXPECTED-RED lines are the baseline shapes this suite tracks.
   Install 4.25111.28, rerun with PHASE=after, and every one must appear as PASS.

```

## AFTER
```bash

2026-08-25 16:19 -0500 (CDT) | 21:19:27 UTC development[~/appdev/src/LinkedIn_Agent/linkedin-agent/scripts/tests]
 tests/$ PHASE=after RUN_PAID=1 ./test-item1-phase2.sh
== test-item1-phase2: PHASE=after BASE_URL=http://localhost:3001 sample_every=2s xact_age_limit=2500ms app_root=/home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent ==
  CALL >>      GET http://localhost:3001/api/platform-admin/tenants auth=cookie(LA_SESSION file) origin=none
  CALL <<      GET http://localhost:3001/api/platform-admin/tenants http=200
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta (no tenantId: resolve the caller home tenant)
  CALL <<      GET http://localhost:3001/api/platform-admin/lab/meta http=200 tenant=53f2e104 topics=13 corroboration=true model=claude-haiku-4-5-20251001
   tenant=53f2e104-4192-439b-abdc-70954bfa9583 topic=ai-practical-benefit angle='Automating a specific business process end-to-end with AI' selection=anthropic/claude-haiku-4-5-20251001
  CALL >>      dbshell.mjs verify (decrypt PG env in memory, connect, no shell)
  CALL <<      dbshell.mjs verify ok=1
== TC-1 source probe ==
  COND         TC-1 success: all four 4.25111.28 markers present (src/db/tenant-workflow.js exists; the lab route runs withTenantWorkflow read-only; the sentinel rollback envelope is gone; five yieldDb crossings: 2 in research.js, 3 in content-generator.js) | failure: any marker absent
  CALL >>      probe tenant-workflow.js, platform-admin-lab-api.js, research.js, content-generator.js under /home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent
  CALL <<      probe workflowFile=yes yieldDb_research=2 yieldDb_generator=3 allPresent=1
  PASS         TC-1 4.25111.28 code markers present in the installed tree
== paid window: one run, pg_stat_activity sampled every 2s ==
  CALL >>      POST http://localhost:3001/api/platform-admin/lab/run tenant=53f2e104 topic=ai-practical-benefit corroboration=on selection=anthropic/claude-haiku-4-5-20251001
  SAMPLE #1 idle_in_txn=1 oldest_xact_ms=3423
  CALL >>      psql UPDATE agent_state key=corroboration tenant=53f2e104 lock_timeout=2500ms (run in flight)
  CALL <<      psql UPDATE elapsed=252ms lockTimeout=no
  SAMPLE #2 idle_in_txn=1 oldest_xact_ms=640
  SAMPLE #3 idle_in_txn=1 oldest_xact_ms=1172
  SAMPLE #4 idle_in_txn=1 oldest_xact_ms=58
  SAMPLE #5 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #6 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #7 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #8 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #9 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #10 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #11 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #12 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #13 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #14 idle_in_txn=1 oldest_xact_ms=71
  SAMPLE #15 idle_in_txn=1 oldest_xact_ms=2233
  SAMPLE #16 idle_in_txn=1 oldest_xact_ms=4409
  SAMPLE #17 idle_in_txn=1 oldest_xact_ms=6598
  SAMPLE #18 idle_in_txn=1 oldest_xact_ms=8790
  CALL <<      POST /lab/run http=200 blocked=false stages=14 totalMs=38908 costUsd=0.046639
METRIC run_total_ms=40688
METRIC samples=18
METRIC idle_in_txn_max=1
METRIC oldest_xact_ms_max=8790
== TC-2 no idle-in-transaction during provider waits ==
  COND         TC-2 success: every mid-run sample shows 0 idle-in-transaction sessions (quiet window assumed: other traffic can hold transactions of its own) | failure: any sample caught a session idle in transaction (the baseline envelope parks there through every provider wait)
  FAIL         TC-2 zero idle-in-transaction sessions across 18 mid-run samples  (max 1 seen; the baseline holds its run transaction through every provider wait)
== TC-3 transaction age stays lease-sized ==
  COND         TC-3 success: oldest in-flight transaction across all samples < 2500ms (leases, ledger writes, log writes are all milliseconds; quiet window assumed) | failure: any sample saw a transaction older than 2500ms (the baseline's single transaction ages to the full run length)
  FAIL         TC-3 oldest mid-run transaction stays lease-sized  (oldest 8790ms >= 2500ms; at run length this is the baseline envelope)
== TC-4 run success and 4.25111.20 response floor ==
  COND         TC-4 success: http=200, result present, cost.totals with keySource=platform, numeric totalMs, NO raw trace field | failure: run failed, or the response floor regressed
  PASS         TC-4 run succeeded under the lease envelope with the .20 response floor
== TC-5 mid-run settings write ==
  COND         TC-5 success: UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the run was in flight | failure: lock_timeout (2500ms) fired or the write took >=1000ms
METRIC lock_write_ms=252
  PASS         TC-5 mid-run settings write completes without blocking
== TC-6 stored corroboration untouched ==
  COND         TC-6 success: meta corroboration reads the same value after the forced-on run as before it | failure: the stored value changed
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta?tenantId=53f2e104-4192-439b-abdc-70954bfa9583 (re-read stored corroboration)
  CALL <<      GET /lab/meta corroboration=true (was true)
  PASS         TC-6 stored corroboration value identical after the forced-on run
== TC-7 no activity rows from the Lab run ==
  COND         TC-7 success: zero activity_log rows for this tenant in the 10 minute window (assumes nothing else used the tenant) | failure: any rows found (under read-only leases a Lab activity write would have failed the run loudly instead; either way rows here are a ruling breach)
  CALL >>      psql SELECT count(activity_log) tenant=53f2e104 window=10min
  CALL <<      psql SELECT count=0
METRIC recent_activity_rows=0
  PASS         TC-7 zero activity rows in the run window
METRIC suite_spend_usd=0.046639

== SUMMARY: PHASE=after pass=5 expected_red=0 warn=0 fail=2 skip=0 spend_estimate_usd=0.046639 ==
```

### AI ASSESSMENT
Before I explain these, I need to identify the exact mechanism behind the two after-phase FAILs. They are real findings, not test noise, and I want the root cause named correctly.These results are the suite doing its job, including catching a real defect in my .28 delivery. Here is what each run says, in plain terms.

**BEFORE: the picture we expected.** Your run took 34 seconds, and all 16 samples caught the same open database transaction, its age climbing in lockstep with the clock (1.2s, 3.7s, 5.9s ... 34.4s). Translation: the Lab run kept one database transaction open for its entire life, doing nothing with it most of that time. The four green invariants confirm Phase 1 is holding: the run works, a settings write mid-run landed in 208ms, the stored setting was untouched, no activity rows leaked.

**AFTER: a large real improvement, and an honest defect.** Two things are true at once.

The improvement is visible in the middle of your run: samples 5 through 13, roughly 18 seconds, show **nothing open at all**. The database was completely free while the app waited on the Model Provider. That state never occurs on the before run, and it is direct proof the lease design works where it is wired. The worst-case open transaction dropped from 34.4 seconds (the whole run) to 8.8 seconds, and the run itself, cost, and all four invariants are unchanged.

The two FAILs are correct and they found a hole in my delivery, not in your environment. Look at samples 15 through 18: one transaction climbing 2.2s, 4.4s, 6.6s, 8.8s right up to the end of the run. Root cause, traced in the code after seeing your output: generation, quality, and refine each have **two** code paths, the legacy direct path and the orchestrated path that runs when `LLM_ABSTRACTION=1`, which per your ruling is always. I placed `yieldDb()` on the legacy branch only. Research has a single path, which is why your run's middle went quiet; but from the last database read before generation onward, one lease rides through both the generation and quality provider waits because neither orchestrated branch ever surrenders it. So two of the run's four provider waits still hold the database.

Why my pre-delivery verification did not catch this: my stub Model Provider answers in about 2 milliseconds, so the un-yielded windows were too short to sample, and my deliberately slow window exercised only web search, which sits on the branch I did cover. Your run, with real provider latency, exposed it exactly the way a TDD suite should.

The fix is small and delivery-ready: `await yieldDb();` before the orchestrated call in the generation, quality, and refine branches, and I will slow the stub's generation and quality in my harness so this class of gap cannot slip past again. After that, the expected re-run picture is zeros nearly everywhere, with one honest residual: your run's opening ~3.4 seconds is a lease held across the real startup reads (topic, articles, prompts), which is database work, not provider waiting; if it still trips the 2500ms bar after the fix, whether to add a yield point inside that burst or accept the number is a judgment I will bring to you with the measurement.

# 4.25111.x-test-item1-phase2 post 4.25111.31
## BEFORE
```bash
hk_LinkedIn_Agent-development (ubuntu) (HEAD)
brandonindia-mcs-progress-id_rsa: git@github.com:brandonindia-mcs/LinkedIn_Agent.git
2026-08-26 09:40 -0500 (CDT) | 14:40:32 UTC development[~/appdev/src/LinkedIn_Agent/linkedin-agent/scripts/tests]
 tests/$ PHASE=before RUN_PAID=1 ./test-item1-phase2.sh
== test-item1-phase2: PHASE=before BASE_URL=http://localhost:3001 sample_every=2s xact_age_limit=2500ms app_root=/home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent ==
  CALL >>      GET http://localhost:3001/api/platform-admin/tenants auth=cookie(LA_SESSION file) origin=none
  CALL <<      GET http://localhost:3001/api/platform-admin/tenants http=200
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta (no tenantId: resolve the caller home tenant)
  CALL <<      GET http://localhost:3001/api/platform-admin/lab/meta http=200 tenant=53f2e104 topics=13 corroboration=false model=claude-haiku-4-5-20251001
   tenant=53f2e104-4192-439b-abdc-70954bfa9583 topic=ai-practical-benefit angle='Automating a specific business process end-to-end with AI' selection=anthropic/claude-haiku-4-5-20251001
  CALL >>      dbshell.mjs verify (decrypt PG env in memory, connect, no shell)
  CALL <<      dbshell.mjs verify ok=1
== TC-1 source probe ==
  COND         TC-1 success: all four Phase 2 markers present (src/db/tenant-workflow.js exists; the lab route runs withTenantWorkflow read-only; the sentinel rollback envelope is gone; yield points 2 in research.js and 6 in content-generator.js, every crossing yielding on BOTH its wire branches per the 4.25111.31 correction) | failure: any marker absent
  CALL >>      probe tenant-workflow.js, platform-admin-lab-api.js, research.js, content-generator.js under /home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent
  CALL <<      probe workflowFile=no yieldDb_research=0
0 yieldDb_generator=0
0 allPresent=0
  EXPECTED-RED TC-1 4.25111.28 code markers present in the installed tree  (markers absent)
== paid window: one run, pg_stat_activity sampled every 2s ==
  CALL >>      POST http://localhost:3001/api/platform-admin/lab/run tenant=53f2e104 topic=ai-practical-benefit corroboration=on selection=anthropic/claude-haiku-4-5-20251001
  SAMPLE #1 idle_in_txn=1 oldest_xact_ms=1219
  CALL >>      psql UPDATE agent_state key=corroboration tenant=53f2e104 lock_timeout=2500ms (run in flight)
  CALL <<      psql UPDATE elapsed=391ms lockTimeout=no
  SAMPLE #2 idle_in_txn=1 oldest_xact_ms=3875
  SAMPLE #3 idle_in_txn=1 oldest_xact_ms=6122
  SAMPLE #4 idle_in_txn=1 oldest_xact_ms=8406
  SAMPLE #5 idle_in_txn=1 oldest_xact_ms=10706
  SAMPLE #6 idle_in_txn=1 oldest_xact_ms=13007
  SAMPLE #7 idle_in_txn=1 oldest_xact_ms=15297
  SAMPLE #8 idle_in_txn=1 oldest_xact_ms=17568
  SAMPLE #9 idle_in_txn=1 oldest_xact_ms=19973
  SAMPLE #10 idle_in_txn=1 oldest_xact_ms=22203
  SAMPLE #11 idle_in_txn=1 oldest_xact_ms=24491
  SAMPLE #12 idle_in_txn=1 oldest_xact_ms=26773
  SAMPLE #13 idle_in_txn=1 oldest_xact_ms=29045
  SAMPLE #14 idle_in_txn=1 oldest_xact_ms=31304
  SAMPLE #15 idle_in_txn=1 oldest_xact_ms=33541
  CALL <<      POST /lab/run http=200 blocked=false stages=14 totalMs=33877 costUsd=0.043315
METRIC run_total_ms=35680
METRIC samples=15
METRIC idle_in_txn_max=1
METRIC oldest_xact_ms_max=33541
== TC-2 no idle-in-transaction during provider waits ==
  COND         TC-2 success: every mid-run sample shows 0 idle-in-transaction sessions (quiet window assumed: other traffic can hold transactions of its own) | failure: any sample caught a session idle in transaction (the baseline envelope parks there through every provider wait)
  EXPECTED-RED TC-2 zero idle-in-transaction sessions across 15 mid-run samples  (max 1 seen; the baseline holds its run transaction through every provider wait)
== TC-3 transaction age stays lease-sized ==
  COND         TC-3 success: oldest in-flight transaction across all samples < 2500ms (leases, ledger writes, log writes are all milliseconds; quiet window assumed) | failure: any sample saw a transaction older than 2500ms (the baseline's single transaction ages to the full run length)
  EXPECTED-RED TC-3 oldest mid-run transaction stays lease-sized  (oldest 33541ms >= 2500ms; at run length this is the baseline envelope)
== TC-4 run success and 4.25111.20 response floor ==
  COND         TC-4 success: http=200, result present, cost.totals with keySource=platform, numeric totalMs, NO raw trace field | failure: run failed, or the response floor regressed
  PASS         TC-4 run succeeded under the lease envelope with the .20 response floor
== TC-5 mid-run settings write ==
  COND         TC-5 success: UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the run was in flight | failure: lock_timeout (2500ms) fired or the write took >=1000ms
METRIC lock_write_ms=391
  PASS         TC-5 mid-run settings write completes without blocking
== TC-6 stored corroboration untouched ==
  COND         TC-6 success: meta corroboration reads the same value after the forced-on run as before it | failure: the stored value changed
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta?tenantId=53f2e104-4192-439b-abdc-70954bfa9583 (re-read stored corroboration)
  CALL <<      GET /lab/meta corroboration=false (was false)
  PASS         TC-6 stored corroboration value identical after the forced-on run
== TC-7 no activity rows from the Lab run ==
  COND         TC-7 success: zero activity_log rows for this tenant in the 10 minute window (assumes nothing else used the tenant) | failure: any rows found (under read-only leases a Lab activity write would have failed the run loudly instead; either way rows here are a ruling breach)
  CALL >>      psql SELECT count(activity_log) tenant=53f2e104 window=10min
  CALL <<      psql SELECT count=0
METRIC recent_activity_rows=0
  PASS         TC-7 zero activity rows in the run window
METRIC suite_spend_usd=0.043315

== SUMMARY: PHASE=before pass=4 expected_red=3 warn=0 fail=0 skip=0 spend_estimate_usd=0.043315 ==
   TDD reading: EXPECTED-RED lines are the baseline shapes this suite tracks.
   Install 4.25111.28, rerun with PHASE=after, and every one must appear as PASS.
```
## AFTER
```bash
hk_LinkedIn_Agent-development (ubuntu) (HEAD)
brandonindia-mcs-progress-id_rsa: git@github.com:brandonindia-mcs/LinkedIn_Agent.git
2026-08-26 09:42 -0500 (CDT) | 14:42:18 UTC development[~/appdev/src/LinkedIn_Agent/linkedin-agent/scripts/tests]
 tests/$ PHASE=after RUN_PAID=1 ./test-item1-phase2.sh
== test-item1-phase2: PHASE=after BASE_URL=http://localhost:3001 sample_every=2s xact_age_limit=2500ms app_root=/home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent ==
  CALL >>      GET http://localhost:3001/api/platform-admin/tenants auth=cookie(LA_SESSION file) origin=none
  CALL <<      GET http://localhost:3001/api/platform-admin/tenants http=200
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta (no tenantId: resolve the caller home tenant)
  CALL <<      GET http://localhost:3001/api/platform-admin/lab/meta http=200 tenant=53f2e104 topics=13 corroboration=false model=claude-haiku-4-5-20251001
   tenant=53f2e104-4192-439b-abdc-70954bfa9583 topic=ai-practical-benefit angle='Automating a specific business process end-to-end with AI' selection=anthropic/claude-haiku-4-5-20251001
  CALL >>      dbshell.mjs verify (decrypt PG env in memory, connect, no shell)
  CALL <<      dbshell.mjs verify ok=1
== TC-1 source probe ==
  COND         TC-1 success: all four Phase 2 markers present (src/db/tenant-workflow.js exists; the lab route runs withTenantWorkflow read-only; the sentinel rollback envelope is gone; yield points 2 in research.js and 6 in content-generator.js, every crossing yielding on BOTH its wire branches per the 4.25111.31 correction) | failure: any marker absent
  CALL >>      probe tenant-workflow.js, platform-admin-lab-api.js, research.js, content-generator.js under /home/ubuntu/appdev/src/LinkedIn_Agent/linkedin-agent
  CALL <<      probe workflowFile=yes yieldDb_research=2 yieldDb_generator=6 allPresent=1
  PASS         TC-1 4.25111.28 code markers present in the installed tree
== paid window: one run, pg_stat_activity sampled every 2s ==
  CALL >>      POST http://localhost:3001/api/platform-admin/lab/run tenant=53f2e104 topic=ai-practical-benefit corroboration=on selection=anthropic/claude-haiku-4-5-20251001
  SAMPLE #1 idle_in_txn=0 oldest_xact_ms=0
  CALL >>      psql UPDATE agent_state key=corroboration tenant=53f2e104 lock_timeout=2500ms (run in flight)
  CALL <<      psql UPDATE elapsed=228ms lockTimeout=no
  SAMPLE #2 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #3 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #4 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #5 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #6 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #7 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #8 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #9 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #10 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #11 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #12 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #13 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #14 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #15 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #16 idle_in_txn=0 oldest_xact_ms=0
  SAMPLE #17 idle_in_txn=0 oldest_xact_ms=0
  CALL <<      POST /lab/run http=200 blocked=false stages=14 totalMs=37419 costUsd=0.045975
METRIC run_total_ms=39783
METRIC samples=17
METRIC idle_in_txn_max=0
METRIC oldest_xact_ms_max=0
== TC-2 no idle-in-transaction during provider waits ==
  COND         TC-2 success: every mid-run sample shows 0 idle-in-transaction sessions (quiet window assumed: other traffic can hold transactions of its own) | failure: any sample caught a session idle in transaction (the baseline envelope parks there through every provider wait)
  PASS         TC-2 zero idle-in-transaction sessions across 17 mid-run samples
== TC-3 transaction age stays lease-sized ==
  COND         TC-3 success: oldest in-flight transaction across all samples < 2500ms (leases, ledger writes, log writes are all milliseconds; quiet window assumed) | failure: any sample saw a transaction older than 2500ms (the baseline's single transaction ages to the full run length)
  PASS         TC-3 oldest mid-run transaction 0ms < 2500ms
== TC-4 run success and 4.25111.20 response floor ==
  COND         TC-4 success: http=200, result present, cost.totals with keySource=platform, numeric totalMs, NO raw trace field | failure: run failed, or the response floor regressed
  PASS         TC-4 run succeeded under the lease envelope with the .20 response floor
== TC-5 mid-run settings write ==
  COND         TC-5 success: UPDATE on the tenant corroboration row returned in <1000ms with no lock timeout while the run was in flight | failure: lock_timeout (2500ms) fired or the write took >=1000ms
METRIC lock_write_ms=228
  PASS         TC-5 mid-run settings write completes without blocking
== TC-6 stored corroboration untouched ==
  COND         TC-6 success: meta corroboration reads the same value after the forced-on run as before it | failure: the stored value changed
  CALL >>      GET http://localhost:3001/api/platform-admin/lab/meta?tenantId=53f2e104-4192-439b-abdc-70954bfa9583 (re-read stored corroboration)
  CALL <<      GET /lab/meta corroboration=false (was false)
  PASS         TC-6 stored corroboration value identical after the forced-on run
== TC-7 no activity rows from the Lab run ==
  COND         TC-7 success: zero activity_log rows for this tenant in the 10 minute window (assumes nothing else used the tenant) | failure: any rows found (under read-only leases a Lab activity write would have failed the run loudly instead; either way rows here are a ruling breach)
  CALL >>      psql SELECT count(activity_log) tenant=53f2e104 window=10min
  CALL <<      psql SELECT count=0
METRIC recent_activity_rows=0
  PASS         TC-7 zero activity rows in the run window
METRIC suite_spend_usd=0.045975

== SUMMARY: PHASE=after pass=7 expected_red=0 warn=0 fail=0 skip=0 spend_estimate_usd=0.045975 ==

```