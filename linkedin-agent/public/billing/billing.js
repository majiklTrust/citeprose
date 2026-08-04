// ═══════════════════════════════════════════════════════════════
// public/billing/billing.js - Billing page logic (2.5.88)
// Serves /app/billing: the about-idiom page (2.5.87). All feedback
// classes match that template's inline stylesheet.
// ═══════════════════════════════════════════════════════════════
// Standalone vanilla JS, house IIFE anatomy. Owner-only: the
// server enforces manage_billing (subscription) and
// manage_llm_vendor (AI vendor); this page also gates locally.
// The nav renders itself into #manager-nav (shared module).
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;

  function $(id) { return document.getElementById(id); }

  // 2.4.35: the template owns the plan cards (compliance-page
  // design). This fills each card's Subscribe href from the
  // server-gated snapshot and reveals only configured tiers.
  // Fail-closed inherit: no checkout, no visible buttons.
  // 2.4.41: live product info from the snapshot's catalog. Uses
  // textContent only (XSS-safe) and touches a field only when the
  // catalog supplies it: static template copy is the fallback at
  // every granularity.
  function applyCatalog(catalog) {
    if (!catalog) return;
    var btns = document.querySelectorAll('.subscribe-btn[data-tier]');
    for (var i = 0; i < btns.length; i++) {
      var tier = btns[i].getAttribute('data-tier');
      var info = catalog[tier];
      if (!info) continue;
      var card = btns[i].closest('.plan');
      if (!card) continue;
      var el;
      if (info.name && (el = card.querySelector('.tag'))) el.textContent = info.name;
      if (info.description && (el = card.querySelector('.desc'))) el.textContent = info.description;
      if (typeof info.amount === 'number' && (el = card.querySelector('.price'))) {
        var whole = Math.floor(info.amount / 100).toLocaleString('en-US');
        var per = info.interval ? ' / ' + info.interval : ' / month';
        var priceText = '$' + whole + per;
        // 2.5.89: the price is a CHECKOUT LINK by design. Write the
        // live price INTO the anchor when the card has one; wiping
        // the container destroyed the link on every card and left
        // plain text. Fallback keeps the old text behavior for a
        // card without an anchor.
        var cta = el.querySelector('.price-cta');
        // 2.5.94: the PRICE always shows once the catalog supplies
        // it; whether it is a LINK is checkout's decision alone.
        // 2.5.89 welded price visibility to link visibility, so a
        // gated checkout (2.4.25) hid the price itself.
        if (cta) { cta.textContent = priceText; cta.hidden = false; }
        else { el.textContent = priceText; }
      }
      if (info.currency && (el = card.querySelector('.cur'))) {
        el.textContent = info.currency + ', billed ' + (info.interval === 'year' ? 'yearly' : 'monthly');
      }
    }
  }

  function fillSubscribeCards(checkout) {
    var hint = $('checkout-hint');
    var any = false;
    // The price CTA and the Purchase button are the same affordance
    // in two positions: identical href, identical state gating.
    var btns = document.querySelectorAll('.subscribe-btn[data-tier], .price-cta[data-tier]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var url = checkout ? checkout[b.getAttribute('data-tier')] : null;
      var isPriceCta = b.classList.contains('price-cta');
      if (url) { b.href = url; b.hidden = false; any = true; }
      else if (isPriceCta) {
        // 2.5.94: an unarmed price keeps SHOWING its amount; it just
        // stops being a link. Only the Purchase button disappears.
        b.removeAttribute('href');
      }
      else { b.removeAttribute('href'); b.hidden = true; }
    }
    if (hint) hint.hidden = !any;
  }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function showMessage(text, type) {
    var el = $('message');
    el.innerHTML = '<div class="' + (type === 'error' ? 'error-box' : 'success-box') + '">' + esc(text) + '</div>';
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
  // Friendly names derive from the tier id itself: no tier list is
  // enumerated here (contract anti-pattern rule).
  function tierDisplay(id) {
    return String(id || '').split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  var STATE_NOTES = {
    trialing: ['Trialing', 'Your grace period is active. The first billing cycle starts when it ends.'],
    active: ['Active', ''],
    past_due: ['Payment Retry In Progress', 'A renewal payment did not complete. Access continues while payment is retried.'],
    suspended: ['Suspended', 'Access is paused. Reactivate below to restore it.'],
    cancelled: ['Cancelled', 'This subscription has ended. A fresh checkout below starts a new one.']
  };

  function livePriceFor(tier) {
    var pa = document.querySelector('.price-cta[data-tier="' + tier + '"]');
    return pa && !pa.hidden && pa.textContent ? pa.textContent : '';
  }

  function markCurrentPlan(tier) {
    var plans = document.querySelectorAll('.pricing-grid .plan');
    for (var i = 0; i < plans.length; i++) {
      var isCur = plans[i].getAttribute('data-plan') === tier;
      plans[i].classList.toggle('current', isCur);
      var tag = plans[i].querySelector('.tag');
      if (tag) tag.textContent = tag.textContent.replace(' (Your Plan)', '') + (isCur ? ' (Your Plan)' : '');
      var buy = plans[i].querySelector('.subscribe-btn');
      if (buy && isCur) buy.hidden = true;
    }
  }

  function renderSubscription(sub) {
    var body = $('subscription-body');
    if (sub.state === 'none') {
      // 2.4.32: the primary purchase persona lives HERE. The early
      // return previously made the subscribe buttons unreachable in
      // exactly this state.
      body.innerHTML = '<div class="hint">No subscription yet - Pick a plan below</div>';
      applyCatalog(sub.catalog);
      fillSubscribeCards(sub.checkout);
      return;
    }
    // 2.5.90: fill the grid FIRST so the summary can read the live
    // price from it; the old order asked for the price before the
    // catalog had written it, so the summary's price line never
    // rendered on a first load (caught by the functional suite).
    applyCatalog(sub.catalog);
    fillSubscribeCards(sub.checkout);
    var note = STATE_NOTES[sub.state] || [sub.state, ''];
    var price = livePriceFor(sub.tier);
    var html = '<div class="plan-summary">';
    html += '<div class="plan-summary-head"><strong>' + esc(tierDisplay(sub.tier)) + '</strong>';
    html += ' <span class="state-badge state-' + esc(sub.state) + '">' + esc(note[0]) + '</span>';
    html += (sub.comp ? ' <span class="state-badge">Complimentary</span>' : '') + '</div>';
    if (price) html += '<div class="plan-summary-line">Price: <strong>' + esc(price) + '</strong> Per 30 Days</div>';
    // 2.5.97: subscription timeline. Each line renders ONLY when its
    // value is present; a null or empty date displays nothing.
    if (sub.periodStart) {
      html += '<div class="plan-summary-line">Started On: <strong>' + esc(new Date(sub.periodStart).toLocaleDateString()) + '</strong></div>';
    }
    if (sub.periodEnd) {
      var when = new Date(sub.periodEnd).toLocaleDateString();
      html += '<div class="plan-summary-line">' + (sub.state === 'cancelled' ? 'Access Ended' : 'Renews On') + ': <strong>' + esc(when) + '</strong></div>';
    }
    if (sub.pendingTier) html += '<div class="plan-summary-line">Changing To: <strong>' + esc(tierDisplay(sub.pendingTier)) + '</strong> At The Next Renewal</div>';
    if (note[1]) html += '<div class="plan-summary-line hint">' + esc(note[1]) + '</div>';

    if (!sub.comp) {
      html += '<div class="row">';
      if (sub.tierChangeEnabled !== false) {
        html += '<select id="tier-select">' + (sub.tiers || []).map(function (tr) {
          return '<option value="' + esc(tr) + '"' + (tr === sub.tier ? ' selected' : '') + '>' + esc(tierDisplay(tr)) + '</option>';
        }).join('') + '</select>';
        html += '<button class="btn btn-primary" id="tier-change">Change Tier At Next Renewal</button>';
      } else {
        // 2.5.101: the portal CTAs speak for themselves; the hint
        // renders only when there is no self-serve path.
        if (!sub.portalUrl) {
          html += '<p class="hint">To change your plan, contact us at accountadmin@***REMOVED***.</p>';
        }
      }
      if (sub.state === 'suspended') html += '<button class="btn" id="reactivate">Reactivate</button>';
      html += '</div>';
    } else {
      html += '<div class="hint">Complimentary subscriptions are managed by the platform operator.</div>';
    }
    html += '</div>';
    body.innerHTML = html;
    markCurrentPlan(sub.tier);
    armPortalCtas(sub);

    var change = $('tier-change');
    if (change) change.addEventListener('click', function () {
      var tier = $('tier-select').value;
      sendJson('POST', '/api/billing/change-tier', { tier: tier }).then(function (r) {
        showMessage(r.ok ? 'Tier change to ' + tierDisplay(tier) + ' takes effect at the next renewal.' : (r.body.error || 'Tier change failed.'), r.ok ? 'success' : 'error');
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

  // 2.5.95: for a LIVE subscription (checkout withheld per 2.4.25),
  // the same CTA slot arms with the Stripe Customer Portal login
  // link: switching happens IN Stripe on the one existing
  // subscription, so a second one can never be created. No portal
  // URL configured means no affordance (fail closed). Suspended
  // keeps its dedicated Reactivate flow.
  function armPortalCtas(sub) {
    if (sub.checkout || !sub.portalUrl || sub.comp) return;
    if (['active', 'trialing', 'past_due'].indexOf(sub.state) === -1) return;
    var btns = document.querySelectorAll('.subscribe-btn[data-tier]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-tier') === sub.tier) continue;
      b.href = sub.portalUrl;
      b.target = '_blank';
      b.rel = 'noopener';
      b.textContent = 'Switch Plans';
      b.classList.add('portal-cta');
      b.hidden = false;
    }
  }

  function loadSubscription() {
    getJson('/api/billing/').then(function (r) {
      if (!r.ok) { $('subscription-body').innerHTML = '<div class="hint">' + esc(r.body.error || 'Failed to load.') + '</div>'; return; }
      renderSubscription(r.body);
    });
  }

  // ── Vendor card (owner-only via manage_llm_vendor) ─────────
  function renderVendor(cfg) {
    var body = $('vendor-body');
    if (!body) return;
    var cur = cfg.current || {};
    var html = '<table><tbody>';
    html += '<tr><td>Current vendor</td><td><strong>' + esc(cur.provider || 'not configured') + '</strong></td></tr>';
    html += '<tr><td>Model</td><td>' + esc(cur.model || 'not configured') + '</td></tr>';
    html += '<tr><td>API key on file</td><td>' + (cur.hasKey ? 'yes (encrypted)' : 'no') + '</td></tr>';
    html += '</tbody></table>';
    html += '<div class="row">';
    html += '<select id="vendor-provider">' + (cfg.providers || []).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === cur.provider ? ' selected' : '') + '>' + esc(p.label || p.id) + '</option>';
    }).join('') + '</select>';
    html += '<select id="vendor-model"></select>';
    html += '</div>';
    // 2.5.96: the key input lives in a guarded FORM with a hidden
    // username field (the 2.5.71/72 convention): satisfies the
    // browser's password-manager heuristics, submits nowhere.
    html += '<form class="key-field row" autocomplete="off" onsubmit="return false">';
    html += '<input type="text" autocomplete="username" value="" tabindex="-1" aria-hidden="true" style="display:none">';
    html += '<input type="password" id="vendor-key" placeholder="API key (kept if blank)" autocomplete="new-password">';
    html += '</form><div class="row">';
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
      if (key) payload.apiKey = key;
      sendJson('PUT', '/api/admin/ai-config', payload).then(function (r) {
        showMessage(r.ok ? 'Vendor validated and saved.' : (r.body.error || 'Save failed.'), r.ok ? 'success' : 'error');
        if (r.ok) loadVendor();
      });
    });
    $('vendor-remove').addEventListener('click', function () {
      if (!window.confirm('Remove the vendor selection and its stored key? Generation then requires a new key or an active platform trial.')) return;
      fetch(API + '/api/admin/ai-config?removeKey=true', { method: 'DELETE', credentials: 'include', headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
        .then(function (r) {
          showMessage(r.ok ? 'Vendor removed. Now using: ' + (r.body.nowUsing || 'platform default') : (r.body.error || 'Remove failed.'), r.ok ? 'success' : 'error');
          if (r.ok) loadVendor();
        });
    });
  }

  function loadVendor() {
    if (!$('vendor-body')) return;
    getJson('/api/admin/ai-config').then(function (r) {
      if (r.status === 403) { $('vendor-body').innerHTML = '<div class="hint">Vendor management requires owner access.</div>'; return; }
      if (!r.ok) { $('vendor-body').innerHTML = '<div class="hint">' + esc(r.body.error || 'Failed to load.') + '</div>'; return; }
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
