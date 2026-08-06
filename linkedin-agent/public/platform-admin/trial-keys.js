// =================================================================
// Platform Admin: Trial Keys card (2.5.85)
// =================================================================
// Console UI over the FIVE existing trial routes (2.5.55/2.5.60):
// create (prove-before-vault), list (with grants since 2.5.85),
// per-key kill switch, activate for a tenant, deactivate a grant.
// Self-contained IIFE: no coupling to platform-admin.js internals.
// The provider field is FREE TEXT by design: the create route
// validates it server-side and answers a clean 400 UNKNOWN_PROVIDER,
// so no vendor list is enumerated here (mirror-seam rule).
(function () {
  var API = window.location.origin;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function msg(text, kind) {
    var el = $("tk-message");
    if (el) el.innerHTML = text ? '<div class="' + (kind === "error" ? "error-box" : "success-box") + '">' + esc(text) + "</div>" : "";
  }
  function getJson(path) {
    return fetch(API + path, { credentials: "include", headers: { "Accept": "application/json" } })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b }; }); });
  }
  function postJson(path, payload) {
    return fetch(API + path, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (res) { return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b }; }); });
  }

  var tenants = [];
  function loadTenants() {
    return getJson("/api/platform-admin/tenants").then(function (r) {
      tenants = (r.ok && (r.body.tenants || r.body.rows || r.body)) || [];
      if (!Array.isArray(tenants)) tenants = [];
    });
  }
  function tenantOptions() {
    return tenants.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name || t.slug || t.id) + "</option>";
    }).join("");
  }
  function usd(v) { return v == null ? "0.0000" : Number(v).toFixed(4); }
  function dt(v) { return v ? new Date(v).toLocaleDateString() : ""; }

  function renderKeys(keys) {
    var host = $("tk-list");
    if (!host) return;
    if (!keys.length) { host.innerHTML = '<p class="hint">No Trial Keys Yet.</p>'; return; }
    var html = "";
    keys.forEach(function (k) {
      html += '<div class="query-card' + (k.active ? "" : " destructive") + '" style="margin-bottom:0.6rem">';
      html += "<strong>" + esc(k.name) + "</strong> (" + esc(k.provider) + ") ";
      html += k.active ? '<span class="badge">Active</span>' : '<span class="badge">Revoked</span>';
      html += '<div class="hint">Fingerprint ' + esc(k.key_fingerprint) + " | Window " + dt(k.starts_at) + " To " + dt(k.ends_at);
      html += " | Key Burn $" + usd(k.spent_usd) + " Of $" + usd(k.max_spend_usd) + " | Active Grants: " + esc(k.active_grants) + "</div>";
      (k.activations || []).forEach(function (a) {
        html += '<div class="hint" style="margin-left:1rem">' + (a.active ? "\u25CF" : "\u25CB") + " ";
        html += esc(a.tenant_name || a.tenant_id) + ": $" + usd(a.spent_usd);
        if (a.max_spend_usd != null) html += " Of $" + usd(a.max_spend_usd);
        html += " Since " + dt(a.activated_at);
        if (a.active) html += ' <button class="btn-small" data-deactivate="' + esc(a.id) + '">Deactivate Grant</button>';
        html += "</div>";
      });
      html += '<div class="param-row" style="margin-top:0.4rem">';
      if (k.active) {
        html += '<select data-activate-tenant="' + esc(k.id) + '">' + tenantOptions() + "</select>";
        html += '<input type="number" min="0" step="0.01" placeholder="Grant Cap USD (Optional)" data-activate-cap="' + esc(k.id) + '">';
        html += '<button class="btn-run" data-activate="' + esc(k.id) + '">Activate For Tenant</button>';
        html += '<button class="btn-small" data-toggle="' + esc(k.id) + '" data-next="false">Revoke Key</button>';
      } else {
        html += '<button class="btn-small" data-toggle="' + esc(k.id) + '" data-next="true">Reactivate Key</button>';
      }
      html += "</div></div>";
    });
    host.innerHTML = html;
  }

  function loadKeys() {
    return getJson("/api/platform-admin/trial-keys").then(function (r) {
      if (!r.ok) { $("tk-list").innerHTML = '<p class="hint">' + esc(r.body.error || "Failed To Load Trial Keys.") + "</p>"; return; }
      renderKeys(r.body.keys || []);
    });
  }

  function isoOf(id) {
    var v = $(id) && $(id).value;
    return v ? new Date(v).toISOString() : null;
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t.id === "tk-create") {
      var payload = {
        provider: ($("tk-provider").value || "").trim(),
        name: ($("tk-name").value || "").trim(),
        apiKey: ($("tk-key").value || "").trim(),
        maxSpendUsd: Number($("tk-cap").value),
        startsAt: isoOf("tk-starts"),
        endsAt: isoOf("tk-ends")
      };
      msg("Validating The Key Against The Vendor...", "info");
      postJson("/api/platform-admin/trial-keys", payload).then(function (r) {
        if (r.ok) { msg("Trial Key Created.", "success"); $("tk-key").value = ""; loadKeys(); }
        else msg(r.body.error || "Create Failed.", "error");
      });
      return;
    }
    if (t.dataset && t.dataset.activate) {
      var id = t.dataset.activate;
      var sel = document.querySelector('[data-activate-tenant="' + id + '"]');
      var cap = document.querySelector('[data-activate-cap="' + id + '"]');
      var capVal = cap && cap.value !== "" ? Number(cap.value) : null;
      postJson("/api/platform-admin/trial-keys/" + id + "/activate",
        { tenantId: sel ? sel.value : null, maxSpendUsd: capVal }).then(function (r) {
        if (r.ok) { msg("Trial Activated For The Tenant. It Now Takes Precedence Over Their Own Key.", "success"); loadKeys(); }
        else msg(r.body.error || "Activation Failed.", "error");
      });
      return;
    }
    if (t.dataset && t.dataset.toggle) {
      postJson("/api/platform-admin/trial-keys/" + t.dataset.toggle + "/active",
        { active: t.dataset.next === "true" }).then(function (r) {
        if (r.ok) { msg(t.dataset.next === "true" ? "Key Reactivated." : "Key Revoked: Every Grant On It Stops Resolving.", "success"); loadKeys(); }
        else msg(r.body.error || "Toggle Failed.", "error");
      });
      return;
    }
    if (t.dataset && t.dataset.deactivate) {
      postJson("/api/platform-admin/trial-activations/" + t.dataset.deactivate + "/deactivate", {}).then(function (r) {
        if (r.ok) { msg("Grant Deactivated. The Tenant's Own Key Resolves Again.", "success"); loadKeys(); }
        else msg(r.body.error || "Deactivate Failed.", "error");
      });
    }
  });

  loadTenants().then(loadKeys);
})();
