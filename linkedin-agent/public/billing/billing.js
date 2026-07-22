// ═══════════════════════════════════════════════════════════════
// public/billing/billing.js - Billing page logic (2.3.5)
// ═══════════════════════════════════════════════════════════════
// Standalone vanilla JS, house IIFE anatomy. Owner-only: the
// server enforces manage_billing (subscription) and
// manage_llm_vendor (AI vendor); this page also gates locally.
// The nav renders itself into #manager-nav (shared module).
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;

  function $(id) { return document.getElementById(id); }

  // Shared by every state that may start a checkout (none, and
  // cancelled through the snapshot's server-side gating). Renders
  // nothing when the server sent no links: fail-closed inherit.
  function buildSubscribeHtml(checkout) {
    if (!checkout) return '';
    var html = '<div class="subscribe-links"><h3>Subscribe</h3>';
    Object.keys(checkout).forEach(function (t) {
      html += '<a class="btn btn-primary subscribe-btn" href="' + checkout[t] + '">' + t + '</a> ';
    });
    html += '<p class="hint">Checkout opens on Stripe. Your workspace activates on payment confirmation.</p></div>';
    return html;
  }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function showMessage(text, type) {
    var el = $('message');
    el.innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + '</div>';
    setTimeout(function () { el.innerHTML = ''; }, 6000);
  }

  function getJson(path) {
    return fetch(API + path, { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); });
  }

  function sendJson(method, path, payload) {
    return fetch(API + path, {
      method: method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); });
  }

  // ── Access check ───────────────────────────────────────────
  function checkAccess() {
    return getJson('/api/status').then(function (r) {
      var user = r.body && r.body.user;
      if (!user || !user.role) return false;
      var perms = r.body.permissions || [];
      return user.role === 'owner' || perms.indexOf('manage_billing') !== -1;
    }).catch(function () { return false; });
  }

  // ── Subscription card ──────────────────────────────────────
  function renderSubscription(sub) {
    var body = $('subscription-body');
    if (sub.state === 'none') {
      // 2.4.32: the primary purchase persona lives HERE. The early
      // return previously made the subscribe buttons unreachable in
      // exactly this state.
      body.innerHTML = '<div class="empty">No subscription yet. Plans open with checkout; the platform operator can also provision access.</div>'
        + buildSubscribeHtml(sub.checkout);
      return;
    }
    var html = '<table><tbody>';
    html += '<tr><td>Tier</td><td><strong>' + esc(sub.tier) + '</strong>' + (sub.comp ? ' (complimentary)' : '') + '</td></tr>';
    html += '<tr><td>State</td><td>' + esc(sub.state) + '</td></tr>';
    if (sub.pendingTier) html += '<tr><td>Pending tier</td><td>' + esc(sub.pendingTier) + ' (next renewal)</td></tr>';
    if (sub.periodEnd) html += '<tr><td>Current period ends</td><td>' + esc(new Date(sub.periodEnd).toLocaleString()) + '</td></tr>';
    html += '</tbody></table>';

    if (!sub.comp) {
      html += '<div class="row">';
      if (sub.tierChangeEnabled !== false) {
        html += '<select id="tier-select">' + (sub.tiers || []).map(function (t) {
          return '<option value="' + esc(t) + '"' + (t === sub.tier ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select>';
        html += '<button class="btn btn-primary" id="tier-change">Change tier at next renewal</button>';
      } else {
        html += '<p class="hint">Tier changes for live subscriptions are handled through support until self-serve upgrades ship.</p>';
      }
      if (sub.state === 'suspended') html += '<button class="btn" id="reactivate">Reactivate</button>';
      html += buildSubscribeHtml(sub.checkout);
      html += '</div>';
    } else {
      html += '<div class="section-note">Complimentary subscriptions are managed by the platform operator.</div>';
    }
    body.innerHTML = html;

    var change = $('tier-change');
    if (change) change.addEventListener('click', function () {
      var tier = $('tier-select').value;
      sendJson('POST', '/api/billing/change-tier', { tier: tier }).then(function (r) {
        showMessage(r.ok ? 'Tier change to ' + tier + ' takes effect at the next renewal.' : (r.body.error || 'Tier change failed.'), r.ok ? 'success' : 'error');
        if (r.ok) loadSubscription();
      });
    });
    var re = $('reactivate');
    if (re) re.addEventListener('click', function () {
      sendJson('POST', '/api/billing/reactivate').then(function (r) {
        if (r.ok && r.body.checkoutUrl) { window.location.href = r.body.checkoutUrl; return; }
        showMessage(r.body.error || (r.ok ? 'Reactivated.' : 'Reactivation failed.'), r.ok ? 'success' : 'error');
      });
    });
  }

  function loadSubscription() {
    getJson('/api/billing/').then(function (r) {
      if (!r.ok) { $('subscription-body').innerHTML = '<div class="empty">' + esc(r.body.error || 'Failed to load.') + '</div>'; return; }
      renderSubscription(r.body);
    });
  }

  // ── Vendor card (owner-only via manage_llm_vendor) ─────────
  function renderVendor(cfg) {
    var body = $('vendor-body');
    var cur = cfg.current || {};
    var html = '<table><tbody>';
    html += '<tr><td>Current vendor</td><td><strong>' + esc(cur.provider || 'platform default') + '</strong></td></tr>';
    html += '<tr><td>Model</td><td>' + esc(cur.model || 'not configured') + '</td></tr>';
    html += '<tr><td>API key on file</td><td>' + (cur.hasKey ? 'yes (encrypted)' : 'no') + '</td></tr>';
    html += '</tbody></table>';
    html += '<div class="row">';
    html += '<select id="vendor-provider">' + (cfg.providers || []).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === cur.provider ? ' selected' : '') + '>' + esc(p.label || p.id) + '</option>';
    }).join('') + '</select>';
    html += '<select id="vendor-model"></select>';
    html += '<input type="password" id="vendor-key" placeholder="API key (kept if blank)">';
    html += '</div><div class="row">';
    html += '<button class="btn btn-primary" id="vendor-save">Validate and Save</button>';
    html += '<button class="btn" id="vendor-remove">Remove vendor</button>';
    html += '</div>';
    body.innerHTML = html;

    function fillModels() {
      var pid = $('vendor-provider').value;
      var entry = (cfg.providers || []).filter(function (p) { return p.id === pid; })[0];
      $('vendor-model').innerHTML = ((entry && entry.models) || []).map(function (m) {
        var id = (m && (m.modelId || m.id)) || m;
        return '<option value="' + esc(id) + '"' + (id === cur.model ? ' selected' : '') + '>' + esc(id) + '</option>';
      }).join('');
    }
    fillModels();
    $('vendor-provider').addEventListener('change', fillModels);

    $('vendor-save').addEventListener('click', function () {
      var payload = { provider: $('vendor-provider').value, model: $('vendor-model').value };
      var key = $('vendor-key').value.trim();
      if (key) payload.api_key = key;
      sendJson('PUT', '/api/admin/ai-config', payload).then(function (r) {
        showMessage(r.ok ? 'Vendor validated and saved.' : (r.body.error || 'Save failed.'), r.ok ? 'success' : 'error');
        if (r.ok) loadVendor();
      });
    });
    $('vendor-remove').addEventListener('click', function () {
      if (!window.confirm('Remove the vendor selection and its stored key? Generation falls back to the platform default if configured.')) return;
      fetch(API + '/api/admin/ai-config?removeKey=true', { method: 'DELETE', credentials: 'include', headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
        .then(function (r) {
          showMessage(r.ok ? 'Vendor removed. Now using: ' + (r.body.nowUsing || 'platform default') : (r.body.error || 'Remove failed.'), r.ok ? 'success' : 'error');
          if (r.ok) loadVendor();
        });
    });
  }

  function loadVendor() {
    getJson('/api/admin/ai-config').then(function (r) {
      if (r.status === 403) { $('vendor-body').innerHTML = '<div class="empty">Vendor management requires owner access.</div>'; return; }
      if (!r.ok) { $('vendor-body').innerHTML = '<div class="empty">' + esc(r.body.error || 'Failed to load.') + '</div>'; return; }
      renderVendor(r.body);
    });
  }

  // ── Boot ───────────────────────────────────────────────────
  checkAccess().then(function (allowed) {
    if (!allowed) { $('denied').style.display = ''; return; }
    $('app').style.display = '';
    loadSubscription();
    loadVendor();
  });
})();
