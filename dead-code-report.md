# Dead Code Report: LinkedIn AI Agent (v2.2.33)

Static reachability analysis of the Node.js backend. Every function listed in
Section 1 was verified by hand after automated detection: its only real-code
occurrence anywhere in the delivered source tree is its own definition. No
caller exists on any input path.

## Scope and method

Files analyzed: 103 Node modules under `src/`, `scripts/`, and the repo root.
Excluded from the primary pass: browser code under `public/` and `***REMOVED***/`
(reachability there is driven by HTML and DOM events, not module imports), and
`src_templates/index.js` and `public_templates/` (build-time source copies of
generated artifacts).

Procedure:

1. A lexical scanner blanks comments, string bodies, and regex literals while
   preserving template `${...}` interpolations, so identifier matches never come
   from inside comments or string data.
2. Module specifiers were parsed from a comment-stripped copy that keeps string
   contents, resolving `import`, `require`, `export ... from`, and dynamic
   `import()` edges.
3. A reachability graph was walked from the real runtime roots: `src/index.js`,
   the PM2 entry `src/launch.js`, and the standalone scripts and require-hooks.
4. Every function, method, and arrow assignment was indexed. A candidate is a
   definition whose name has zero references outside its own definition token.
5. Each candidate was then read in source to rule out the ways static counting
   can be wrong: named function expressions used by value, default-export
   aliasing, dynamic dispatch, and runtime module discovery.

A hard constraint drove the shape of the output: no false positives. Where
static analysis could not prove a function dead, it was moved out of Section 1.

## Summary

* Section 1, truly dead production functions: 36 functions, 335 lines, across 24 files.
* Section 2, test and diagnostic seams: dead in this archive only because the
  test suite (`scripts/testing/`) is excluded by the packaging script.
* Section 3, one dead data module (`src/config/topics.js`).
* Section 4, candidates the automated pass raised and manual review cleared,
  with the reason each is actually reachable.

---

## Section 1. Truly dead functions (unreachable on every input)

Each entry gives the file, the function, the exact line range, a note on the
most likely reason it is dead, and the line numbered source block. All are
`export`ed but imported by nothing, and referenced by nothing internally.

### `src/auth/index.js`

**`isAuthRequired`** lines 367-369 (3 lines). lifecycle/status helper; status route never calls it.

```javascript
  367  export function isAuthRequired() {
  368    return authRequired;
  369  }
```

**`shutdownRegistry`** lines 374-388 (15 lines). graceful-shutdown hook; never wired to a signal handler.

```javascript
  374  export async function shutdownRegistry(logFn) {
  375    for (const [name, provider] of activeProviders) {
  376      if (typeof provider.shutdown === "function") {
  377        try {
  378          await provider.shutdown();
  379          if (logFn) logFn("info", "auth_provider_shutdown", { name });
  380        } catch (err) {
  381          if (logFn) logFn("error", "auth_provider_shutdown_error", { name, error: err.message });
  382        }
  383      }
  384    }
  385    activeProviders.clear();
  386    providerSnapshots.clear();
  387    registryInitialized = false;
  388  }
```

### `src/auth/jwt-verifier.js`

**`clearJwksCache`** lines 107-109 (3 lines). cache-reset util; no caller.

```javascript
  107  export function clearJwksCache() {
  108    jwksSets.clear();
  109  }
```

### `src/auth/session.js`

**`isSessionExpiring`** lines 333-337 (5 lines). session-refresh predicate; no caller.

```javascript
  333  export function isSessionExpiring(session, thresholdMs = SESSION_EXPIRING_THRESHOLD_MS) {
  334    if (!session) return true;
  335    if (typeof session.expiresAt !== 'number') return true;
  336    return session.expiresAt - Date.now() <= thresholdMs;
  337  }
```

### `src/config/linkedin-scopes.js`

**`getLinkedInScopeString`** lines 36-38 (3 lines). scope-string builder; no caller.

```javascript
   36  export function getLinkedInScopeString() {
   37    return LINKEDIN_OAUTH_SCOPES.join(" ");
   38  }
```

**`getLinkedInMemberScopeString`** lines 56-58 (3 lines). scope-string builder; no caller.

```javascript
   56  export function getLinkedInMemberScopeString() {
   57    return LINKEDIN_MEMBER_OAUTH_SCOPES.join(" ");
   58  }
```

### `src/config/research.js`

**`getDashboardFeedLimit`** lines 55-58 (4 lines). config getter; no caller.

```javascript
   55  export function getDashboardFeedLimit() {
   56    const val = parseInt(process.env.DASHBOARD_FEED_LIMIT, 10);
   57    return val > 0 ? val : DEFAULT_DASHBOARD_FEED_LIMIT;
   58  }
```

### `src/llm/security.js`

**`redactHeaders`** lines 52-59 (8 lines). log-redaction util; no caller.

```javascript
   52  export function redactHeaders(headers) {
   53    const out = {};
   54    if (!headers || typeof headers !== "object") return out;
   55    for (const [key, value] of Object.entries(headers)) {
   56      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : value;
   57    }
   58    return out;
   59  }
```

### `src/services/batch-publisher.js`

**`stopBatchPublisher`** lines 165-170 (6 lines). lifecycle stop; start is used, stop is not.

```javascript
  165  export function stopBatchPublisher() {
  166    if (publisherJob) {
  167      publisherJob.stop();
  168      console.log("🗓️  Batch publisher stopped");
  169    }
  170  }
```

### `src/services/content-generator.js`

**`getTopicByIdFromDb`** lines 87-89 (3 lines). superseded by DB topic-store lookups.

```javascript
   87  export async function getTopicByIdFromDb(topicId) {
   88    return getTopicBySlug(topicId);
   89  }
```

**`getAvailableTopics`** lines 91-94 (4 lines). superseded by DB topic-store lookups.

```javascript
   91  export async function getAvailableTopics(userSub = null) {
   92    const topics = await getTopicsForGeneration(userSub);
   93    return topics.map(t => ({ id: t.slug, name: t.name }));
   94  }
```

### `src/services/database.js`

**`initDatabase`** lines 87-142 (56 lines). self-described legacy throwing stub; no caller.

```javascript
   87  export function initDatabase() {
   88    throw new Error(
   89      "initDatabase() is legacy — Postgres schema is managed externally " +
   90      "via data/pgsql/ DDL files. Remove this call from the app startup path."
   91    );
   92  
   93    // UNREACHABLE CODE
   94    db = new Database(DB_PATH);
   95    db.pragma("journal_mode = WAL");
   96    db.pragma("foreign_keys = ON");
   97  
   98    db.exec(`
   99      CREATE TABLE IF NOT EXISTS posts (
  100        id            INTEGER PRIMARY KEY AUTOINCREMENT,
  101        topic_id      TEXT NOT NULL,
  102        title         TEXT NOT NULL,
  103        content       TEXT NOT NULL,
  104        hashtags      TEXT,           -- JSON array
  105        status        TEXT NOT NULL DEFAULT 'draft',
  106          -- draft | pending_approval | approved | posted | rejected | failed
  107        linkedin_id   TEXT,           -- LinkedIn post URN after posting
  108        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  109        scheduled_for DATETIME,
  110        posted_at     DATETIME,
  111        error_message TEXT,
  112        news_context  TEXT            -- source context used for generation
  113      );
  114  
  115      CREATE TABLE IF NOT EXISTS agent_state (
  116        key   TEXT PRIMARY KEY,
  117        value TEXT NOT NULL
  118      );
  119  
  120      CREATE TABLE IF NOT EXISTS activity_log (
  121        id         INTEGER PRIMARY KEY AUTOINCREMENT,
  122        timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
  123        level      TEXT NOT NULL,
  124        action     TEXT NOT NULL,
  125        details    TEXT
  126      );
  127  
  128      CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
  129      CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);
  130      CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_for);
  131    `);
  132  
  133    // Initialize default agent state
  134    const upsert = db.prepare(`
  135      INSERT OR IGNORE INTO agent_state (key, value) VALUES (?, ?)
  136    `);
  137    upsert.run("mode", process.env.AGENT_MODE || "manual");
  138    upsert.run("last_topic_id", "");
  139    upsert.run("paused", "false");
  140  
  141    return db;
  142  }
```

### `src/services/feed-validator.js`

**`validateFeeds`** lines 354-372 (19 lines). batch validator; only single validateFeed is used.

```javascript
  354  export async function validateFeeds(urls, concurrency = 4) {
  355    const results = new Array(urls.length);
  356    let cursor = 0;
  357  
  358    async function worker() {
  359      while (cursor < urls.length) {
  360        const idx = cursor++;
  361        results[idx] = await validateFeed(urls[idx]);
  362      }
  363    }
  364  
  365    const workers = Array.from(
  366      { length: Math.min(concurrency, urls.length) },
  367      () => worker()
  368    );
  369    await Promise.all(workers);
  370  
  371    return results;
  372  }
```

### `src/services/linkedin-api.js`

**`clearTokenCache`** lines 295-300 (6 lines). cache-reset util; no caller.

```javascript
  295  export function clearTokenCache() {
  296    const tenantId = currentTenantId();
  297    if (tenantId) {
  298      _tokenCacheByTenant.delete(tenantId);
  299    }
  300  }
```

### `src/services/metric-store.js`

**`getMetricGroupsForTopic`** lines 134-149 (16 lines). metric getter; no caller.

```javascript
  134  export async function getMetricGroupsForTopic(topicRef) {
  135    const topicId = requireTopicRef(topicRef);
  136    const c = await tenantClient();
  137    const r = await c.query(
  138      `SELECT g.id AS group_id, g.slug AS group_slug, g.label AS group_label
  139       FROM metric_groups g
  140       WHERE g.topic_id = $1 AND g.enabled = TRUE
  141       ORDER BY g.slug`,
  142      [topicId]
  143    );
  144    return r.rows.map(row => ({
  145      groupId: row.group_id,
  146      groupSlug: row.group_slug,
  147      groupLabel: row.group_label
  148    }));
  149  }
```

**`getMetricByKey`** lines 151-168 (18 lines). metric getter; no caller.

```javascript
  151  export async function getMetricByKey(metricKey) {
  152    if (typeof metricKey !== "string" || metricKey.trim() === "") {
  153      throw new Error("getMetricByKey: a non-empty metric_key is required.");
  154    }
  155    const c = await tenantClient();
  156    const r = await c.query(
  157      `SELECT v.metric_key, v.value, v.unit, v.enabled,
  158              v.source_quote, v.source_name, v.source_locator, v.source_url,
  159              g.slug AS group_slug, g.label AS group_label
  160       FROM metric_values v
  161       JOIN metric_groups g
  162         ON g.tenant_id = v.tenant_id AND g.id = v.group_id
  163       WHERE v.metric_key = $1 AND v.enabled = TRUE
  164       LIMIT 1`,
  165      [metricKey.trim()]
  166    );
  167    return r.rows.length ? rowToMetric(r.rows[0]) : null;
  168  }
```

### `src/services/news-monitor.js`

**`searchArticles`** lines 530-573 (44 lines). search util; no caller.

```javascript
  530  export async function searchArticles(keywords, topicSlug = null, maxAgeDays = null, limit = 20) {
  531    const ageDays = maxAgeDays || getMaxAgeDays();
  532    const c = client();
  533    const conditions = [];
  534    const params = [];
  535    let i = 1;
  536  
  537    for (const kw of keywords) {
  538      conditions.push(`(a.title ILIKE $${i} OR a.summary ILIKE $${i})`);
  539      params.push(`%${kw}%`);
  540      i++;
  541    }
  542  
  543    if (topicSlug) {
  544      conditions.push(`t.slug = $${i}`);
  545      params.push(topicSlug);
  546      i++;
  547    }
  548  
  549    conditions.push(`a.published_at >= now() - ($${i} || ' days')::interval`);
  550    params.push(String(ageDays));
  551    i++;
  552    params.push(limit);
  553  
  554    const topicJoin = topicSlug
  555      ? `JOIN feed_topics ft ON ft.feed_id = f.id
  556         JOIN topics t ON t.id = ft.topic_id`
  557      : "";
  558  
  559    const sql = `
  560      SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
  561             a.image_url, f.name AS feed_name, f.tier::text AS feed_tier
  562      FROM articles_v2 a
  563      JOIN feed_articles fa ON fa.article_id = a.id
  564      JOIN feeds_v2 f ON f.id = fa.feed_id
  565      ${topicJoin}
  566      WHERE ${conditions.join(" AND ")}
  567      ORDER BY a.published_at DESC
  568      LIMIT $${i}
  569    `;
  570  
  571    const r = await c.query(sql, params);
  572    return r.rows;
  573  }
```

**`stopMonitor`** lines 661-666 (6 lines). lifecycle stop; start is used, stop is not.

```javascript
  661  export function stopMonitor() {
  662    if (monitorJob) {
  663      monitorJob.stop();
  664      console.log("📡 News monitor stopped");
  665    }
  666  }
```

### `src/services/platform-secret.js`

**`encryptPlatformSecret`** lines 58-68 (11 lines). encrypt half unused; decrypt is used (may be used by out-of-archive ../build tooling).

```javascript
   58  export function encryptPlatformSecret(plaintext) {
   59    if (typeof plaintext !== "string" || plaintext.length === 0) {
   60      throw new Error("plaintext must be a non-empty string");
   61    }
   62    const key = deriveKey();
   63    const iv = randomBytes(IV_LENGTH);
   64    const cipher = createCipheriv("aes-256-gcm", key, iv);
   65    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
   66    const authTag = cipher.getAuthTag();
   67    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
   68  }
```

### `src/services/post-status.js`

**`isPrePublication`** lines 37-39 (3 lines). status predicate; no caller.

```javascript
   37  export function isPrePublication(status) {
   38    return PRE_PUB.has(status);
   39  }
```

### `src/services/prompt-actions.js`

**`getActionDefinition`** lines 202-204 (3 lines). registry getter; no caller.

```javascript
  202  export function getActionDefinition(actionId) {
  203    return ACTION_REGISTRY[actionId] || null;
  204  }
```

**`listActions`** lines 212-218 (7 lines). registry lister; no caller.

```javascript
  212  export function listActions() {
  213    return Object.entries(ACTION_REGISTRY).map(([id, def]) => ({
  214      actionId: id,
  215      description: def.description,
  216      requiredPermission: def.requiredPermission
  217    }));
  218  }
```

### `src/services/prompt-vault.js`

**`listPrompts`** lines 391-396 (6 lines). vault lister; no caller.

```javascript
  391  export async function listPrompts() {
  392    const result = await query(
  393      "SELECT key, genre, description, updated_at, metric_bearing FROM prompt_vault ORDER BY key, metric_bearing, genre"
  394    );
  395    return result.rows;
  396  }
```

### `src/services/scheduler.js`

**`stopScheduler`** lines 364-369 (6 lines). lifecycle stop; start is used, stop is not.

```javascript
  364  export function stopScheduler() {
  365    if (schedulerJob) {
  366      schedulerJob.stop();
  367      console.log("⏰ Scheduler stopped");
  368    }
  369  }
```

### `src/services/search-queries.js`

**`buildQueriesForTopic`** lines 128-130 (3 lines). superseded by buildQueriesForTopicDetailed.

```javascript
  128  export function buildQueriesForTopic(topic, angle) {
  129    return buildQueriesForTopicDetailed(topic, angle).queries;
  130  }
```

### `src/services/security.js`

**`safeErrorResponse`** lines 41-57 (17 lines). error helper; no caller.

```javascript
   41  export function safeErrorResponse(res, statusCode, logFn, action, err) {
   42    const ref = Date.now().toString(36);
   43    const detail = {
   44      ref,
   45      error: err.message,
   46      stack: err.stack?.split("\n").slice(0, 2).join(" | ")
   47    };
   48  
   49    if (logFn) {
   50      try { logFn("error", action, detail); } catch { /* logging must not throw */ }
   51    }
   52  
   53    res.status(statusCode).json({
   54      error: "An internal error occurred.",
   55      ref
   56    });
   57  }
```

**`isValidTopicId`** lines 72-74 (3 lines). validator; no caller.

```javascript
   72  export function isValidTopicId(topicId) {
   73    return topicId === null || topicId === undefined || VALID_TOPICS.has(topicId);
   74  }
```

**`isValidStatus`** lines 76-78 (3 lines). validator; no caller.

```javascript
   76  export function isValidStatus(status) {
   77    return !status || VALID_STATUSES.has(status);
   78  }
```

**`isValidMode`** lines 80-82 (3 lines). validator; no caller.

```javascript
   80  export function isValidMode(mode) {
   81    return VALID_MODES.has(mode);
   82  }
```

**`parseId`** lines 84-90 (7 lines). parser; no caller.

```javascript
   84  export function parseId(value) {
   85    if (typeof value !== "string" && typeof value !== "number") return null;
   86    const parsed = parseInt(value, 10);
   87    if (isNaN(parsed) || parsed < 1 || parsed > 999999) return null;
   88    if (String(parsed) !== String(value).trim()) return null;  // reject "123abc"
   89    return parsed;
   90  }
```

**`sanitizeInt`** lines 92-96 (5 lines). sanitizer; no caller.

```javascript
   92  export function sanitizeInt(value, defaultVal, min = 1, max = 1000) {
   93    const parsed = parseInt(value, 10);
   94    if (isNaN(parsed)) return defaultVal;
   95    return Math.max(min, Math.min(max, parsed));
   96  }
```

**`sanitizeString`** lines 98-101 (4 lines). sanitizer; no caller.

```javascript
   98  export function sanitizeString(str, maxLength = 500) {
   99    if (typeof str !== "string") return "";
  100    return str.slice(0, maxLength);
  101  }
```

### `src/services/template-crypto.js`

**`verifyTemplateFingerprint`** lines 36-39 (4 lines). self-described placeholder; no caller.

```javascript
   36  export function verifyTemplateFingerprint(plaintext, fingerprint) {
   37    console.log("[template-crypto] verifyTemplateFingerprint (placeholder)");
   38    return true;
   39  }
```

### `src/tenant/invite-store.js`

**`markInviteClaimed`** lines 95-105 (11 lines). invite mutation; no caller.

```javascript
   95  export async function markInviteClaimed(inviteId, claimedBySub) {
   96    const c = currentClient();
   97    await c.query(
   98      `UPDATE invites
   99       SET status = 'claimed'::invite_status,
  100           claimed_at = now(),
  101           claimed_by_sub = $2
  102       WHERE id = $1`,
  103      [inviteId, claimedBySub]
  104    );
  105  }
```

### `src/tenant/platform-db.js`

**`expireStaleRegistrations`** lines 340-349 (10 lines). cleanup job; never scheduled/called.

```javascript
  340  export async function expireStaleRegistrations() {
  341    const result = await query(
  342      `UPDATE tenant_registrations
  343       SET status = 'expired',
  344           api_key_enc = NULL
  345       WHERE status IN ('pending', 'active')
  346         AND expires_at <= now()`
  347    );
  348    return result.rowCount;
  349  }
```

### `src/tenant/seed-defaults.js`

**`getCatchallFeedList`** lines 197-203 (7 lines). seed helper; no caller.

```javascript
  197  export function getCatchallFeedList() {
  198    return CATCHALL_FEEDS.map(f => ({
  199      name: f.name,
  200      url: f.url,
  201      tier: f.tier
  202    }));
  203  }
```

---

## Section 2. Test and diagnostic seams (dead in the shipped archive only)

These are unreferenced inside the delivered tree, but each is an intentional
hook whose caller is the test suite under `scripts/testing/`, which the
`zipsrc` packaging script excludes with `-x "**/testing/*"`. Naming and inline
comments confirm intent. They are reported separately because their
unreachability is an artifact of packaging, not a defect in the code.

* `src/index.js:787` `buildAppForTests` : builds the Express app for supertest without binding a port.
* `src/auth/index.js:393` `_resetForTesting` : clears the provider registry between tests.
* `src/auth/index.js:412` `_patchSnapshotForTesting` : overrides a provider snapshot in tests.
* `src/tenant/platform-db.js:86` `_resetPermissionCacheForTesting` : flushes the permission cache in tests.
* `src/auth/providers/auth0.js:515` `_getConfig` : test/diagnostic accessor on the provider object.
* `src/auth/providers/auth0.js:516` `_getStateCount` : test/diagnostic accessor on the provider object.
* `src/auth/providers/auth0.js:519` `_getDiscoveryCache` : test/diagnostic accessor on the provider object.
* `src/auth/_test-helper.js:31` `createTestJWKS` : whole file is a JWKS test harness; consumers excluded.
* `src/auth/_test-helper.js:101` `signExpiredToken` : test token forger.
* `src/auth/_test-helper.js:109` `signWrongIssuerToken` : test token forger.
* `src/auth/_test-helper.js:116` `signWrongAudienceToken` : test token forger.
* `src/auth/_test-helper.js:123` `fabricateToken` : test token forger.

If the intent is to ship without the test suite, these can be deleted; if the
test suite is meant to travel with the source, the packaging exclusion is the
thing to fix, not the code.

---

## Section 3. Dead data module

`src/config/topics.js` exports `TOPICS` (line 5) and `ROTATION_CONFIG`
(line 110). Neither is imported or referenced anywhere in the delivered tree.
Topic definitions are now served from the database through
`src/tenant/topic-store.js` and `src/services/content-generator.js`, so this
static file is a superseded remnant. It contains data, not functions, so it is
listed here rather than in Section 1.

---

## Section 4. Cleared by manual review (reported for transparency, NOT dead)

The automated pass flagged these as zero-reference, but each is reachable. They
are listed so the analysis is auditable and so no one deletes them by mistake.

Named function expressions, used by value not by name:

* `scripts/traffic-monitor.cjs:98` `patchedRequest`, `:170` `patchedGet`,
  `:186` `patchedCreateServer` : assigned onto `http.request`, `http.get`, and
  `http.createServer`, then invoked by Node's http machinery.
* `src/tenant/resolver.js:20` `tenantResolver` : returned as Express middleware
  from its factory.
* `src/tenant/permissions.js:34` `permissionCheck`, `:69` `devBypassBlock` :
  returned as Express middleware from their factories.

Runtime-discovered modules, loaded by computed path:

* `src/auth/providers/auth0.js` and `src/auth/providers/mock.js` : loaded by
  `src/auth/index.js` via `readdir` of the providers directory and
  `await import(filepath)`. The default export and its interface methods
  (`init`, `getRoutes`, `isConfigured`, and so on) run through that dynamic
  path, which no static resolver can follow.

Standalone executables, run directly rather than imported:

* `content_generator-default-prompt.js` and
  `content_generator-verifiable-50-prompt.js` : one-time prompt-vault seed
  scripts with a `#!/usr/bin/env node` shebang and `process.argv` handling.
  Their bodies run on `node <file>`; their only helper, `confirm`, is called by
  `seed`. These two files are near-duplicates of each other and are marked
  "DELETE THIS FILE after successful seeding" in their own headers, so they are
  cleanup candidates, but they are not dead functions.

---

## Limitations, stated plainly

* Consumers outside the archive cannot be seen. A few Section 1 entries could in
  principle be called by out-of-tree tooling. `encryptPlatformSecret` is the
  clearest case: the `encrypt-key` and `decrypt-key` npm scripts point at
  `../build/encrypt-key.js`, which is not in this zip. Its note flags this.
* Client-side code under `public/` was not analyzed. Backend functions there
  would be reached over HTTP, not by import, so they cannot appear as callers of
  the functions above in any case.
* Reachability is decided at the level of whether any caller exists, which is the
  correct question for "can this function ever be called." Statement-level dead
  code inside otherwise-live functions was not the target of this pass.