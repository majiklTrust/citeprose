// ═══════════════════════════════════════════════════════════════
// Platform Logger (2.4.1): console + persistent event store
// ═══════════════════════════════════════════════════════════════
//
// The console line every caller has always gotten remains the
// first, unconditional act: persistence is additive, best-effort,
// and can NEVER change the caller's outcome. Three iron rules:
//
//   1. platformLog never throws. Any persistence failure falls
//      back to a plain console.error.
//   2. platformLog never recurses. The failure path logs with
//      console directly, not with platformLog.
//   3. Persistence never blocks. The insert is fire-and-forget;
//      callers do not await the database.
//
// Detail payloads are clamped (8 KB) so a hostile or runaway
// caller cannot flood the table through a single event. Tenant
// context is captured from AsyncLocalStorage when present.
// PLATFORM_LOG_PERSIST=off disables persistence (console stays).
// ═══════════════════════════════════════════════════════════════

const LEVELS = ["debug", "info", "warn", "error"];
const DETAIL_MAX_CHARS = 8192;

function safeStringify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.stringify({ message: value });
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : null;
  } catch {
    // Circular or otherwise unserializable: preserve what we can.
    return JSON.stringify({ unserializable: true, hint: String(value).slice(0, 200) });
  }
}

let persistOffAnnounced = false;

async function persist(level, action, detailJson) {
  try {
    if ((process.env.PLATFORM_LOG_PERSIST || "on") === "off") {
      // 4.25111.38: dark persistence must announce itself ONCE. A
      // day of failures was invisible to every database-side error
      // query because nothing said the store was disabled.
      if (!persistOffAnnounced) {
        persistOffAnnounced = true;
        console.warn("[platform-log] persistence is DISABLED (PLATFORM_LOG_PERSIST=off): events reach the console only");
      }
      return;
    }
    let tenantId = null;
    try {
      const { currentTenantId } = await import("../db/with-tenant.js");
      tenantId = currentTenantId() || null;
    } catch { /* no tenant context machinery available: platform-level */ }
    const clamped = detailJson && detailJson.length > DETAIL_MAX_CHARS
      ? JSON.stringify({ truncated: true, head: detailJson.slice(0, DETAIL_MAX_CHARS) })
      : detailJson;
    const { query } = await import("../db/pool.js");
    await query(
      `INSERT INTO platform_log (level, event, detail, tenant_id)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [level, String(action), clamped, tenantId]
    );
  } catch (err) {
    // Rule 2: the failure path never calls platformLog.
    console.error(`[platform-log] persistence failed for ${action}: ${err.message}`);
  }
}

export function platformLog(level, action, details) {
  const ts = new Date().toISOString();
  const normalized = LEVELS.includes(String(level)) ? String(level) : "info";
  const upper = normalized.toUpperCase();
  const payload = details === null || details === undefined ? "" : (
    typeof details === "string" ? details : (() => {
      try { return JSON.stringify(details); } catch { return "[unserializable]"; }
    })()
  );
  console.log(`${ts} [PLATFORM:${upper}] ${action}${payload ? " " + payload : ""}`);
  // Rule 3: fire-and-forget; the returned promise is deliberately
  // not exposed to callers.
  persist(normalized, action, safeStringify(details));
}

// Retention: prune persisted events older than the window. Runs
// platform-level from the scheduler, like the payments lapse
// sweep. Returns the pruned row count.
export async function prunePlatformLog() {
  const daysRaw = Number(process.env.PLATFORM_LOG_RETENTION_DAYS);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 90;
  const { query } = await import("../db/pool.js");
  const { rowCount } = await query(
    `DELETE FROM platform_log WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  if (rowCount > 0) {
    console.log(`[platform-log] retention pruned ${rowCount} events older than ${days} days`);
  }
  return rowCount;
}
