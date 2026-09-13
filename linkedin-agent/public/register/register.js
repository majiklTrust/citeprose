// ═══════════════════════════════════════════════════════════════
// public/register/register.js — Registration form logic
// ═══════════════════════════════════════════════════════════════
// Token-based authentication. No session cookie. The registration
// token in the URL fragment is the sole authorization.
//
// 4.25111.98 (D84-2): the vendor and model choices are the catalog
// the init answer carries (providers: the registry's configured
// providers with availability, notice and registry models, the same
// list the /app/admin card renders from GET /api/admin/ai-config).
// The page renders that catalog and nothing else: no hardcoded
// vendor list, no free-text model, and the model list is never
// rebuilt from the live catalog validate-key returns. A parked
// (coming soon) vendor shows its notice and disables Verify and
// Create, exactly as the admin card does; the server refuses it
// again at /api/register/complete. Catalog values reach the DOM
// through createElement and textContent only.
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;
  var registrationToken = null;
  var _providers = [];

  function $(id) { return document.getElementById(id); }

  function showMessage(text, type) {
    var el = $('message');
    if (!el) return;
    el.innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + '</div>';
    if (type !== 'error') {
      setTimeout(function () { el.innerHTML = ''; }, 5000);
    }
  }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Extract token from URL fragment ────────────────────────
  // Fragment (#token=xxx) is never sent to the server in HTTP
  // requests — prevents token exposure in server logs, proxy
  // logs, and referrer headers.

  function extractToken() {
    var hash = window.location.hash;
    if (!hash) return null;
    var match = hash.match(/token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  // ── Initialize ─────────────────────────────────────────────

  function initRegistration() {
    registrationToken = extractToken();
    if (!registrationToken) {
      // F4 resolution: a MISSING token is its own named state, not
      // an invalid link. Fragments never leave the browser, so
      // bookmarks, typed URLs, and redirect chains arrive here
      // bare; that is an ordinary arrival, not an error. Recovery
      // routes to the dashboard CTA, which converges on the
      // caller's live link (REISSUED) or mints one (CREATED)
      // through the store's atomic adjudication: the authoritative,
      // idempotent endpoint recovers, never client-side state.
      // The page stays stateless and the CTA is same-origin
      // relative, so behavior is identical on every instance
      // behind the balancer. Explicit click, never an auto
      // redirect: no loop risk if /app/ ever bounces back here.
      // Version-skew guard: this file and the HTML deploy as
      // separate static assets; during a rolling deploy the older
      // page may lack the no-token panel, so fall back to the
      // invalid panel rather than render nothing.
      $('loading').style.display = 'none';
      ($('no-token') || $('invalid')).style.display = 'block';
      return;
    }

    // Clear the token from the URL bar (defense in depth)
    if (window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    fetch(API + '/api/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: registrationToken })
    })
      .then(function (res) {
        if (!res.ok) {
          $('loading').style.display = 'none';
          $('invalid').style.display = 'block';
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        $('loading').style.display = 'none';
        $('step-form').style.display = 'block';
        $('reg-email').value = data.email;

        // 4.25111.98: the catalog, rendered before anything else so the
        // vendor and model lists are on the page with the form.
        _providers = Array.isArray(data.providers) ? data.providers.filter(function (p) { return p && typeof p === 'object' && typeof p.id === 'string' && p.id; }) : [];
        renderProviders();
        applyVendorUx();

        // If admin pre-provided the API key, hide the whole key block
        // (vendor choice included: the invitation made it). closest()
        // because the key field now lives in its own form (D84-1).
        if (data.keyProvided) {
          $('reg-key').closest('.form-row').style.display = 'none';
          $('verify-actions').style.display = 'none';
          // Show "provided" message and the register button directly
          var infoDiv = document.createElement('div');
          infoDiv.className = 'msg msg-info';
          infoDiv.textContent = 'Your API key and model have been configured by your administrator.';
          $('message').appendChild(infoDiv);
          $('model-section').classList.add('visible');
          $('model-section').innerHTML = '<div class="form-row"><label>Model</label><input type="text" readonly value="' + esc(data.modelId || 'Configured by admin') + '" style="opacity:0.6;"></div><div class="actions"><button class="btn btn-primary" id="register-btn">Create Workspace</button></div>';
          $('register-btn').addEventListener('click', completeRegistration);
        }

        // Show expiry countdown
        var expires = new Date(data.expiresAt);
        $('expires-info').textContent = 'Link expires: ' + expires.toLocaleTimeString();

        // Start expiry check
        setInterval(function () {
          if (new Date() > expires) {
            showMessage('This registration link has expired. Please request a new one.', 'error');
            $('verify-btn').disabled = true;
            $('register-btn').disabled = true;
          }
        }, 10000);
      })
      .catch(function () {
        $('loading').style.display = 'none';
        $('invalid').style.display = 'block';
      });
  }

  // ── Verify API Key ─────────────────────────────────────────

  function verifyKey() {
    var key = $('reg-key').value.trim();
    var provider = $('reg-provider').value;
    if (vendorComingSoon(provider)) {
      showMessage(vendorNoticeFor(provider), 'error');
      return;
    }
    if (!provider) {
      showMessage('Choose an AI vendor first', 'error');
      return;
    }
    if (!key) {
      showMessage('Please enter your vendor API key', 'error');
      return;
    }

    $('verify-btn').disabled = true;
    $('verify-btn').textContent = 'Verifying...';
    $('key-status').innerHTML = '<span class="key-status key-checking">checking...</span>';

    fetch(API + '/api/register/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: registrationToken, apiKey: key, provider: provider })
    })
      .then(function (res) {
        if (res.status === 401) {
          $('key-status').innerHTML = '<span class="key-status key-invalid">invalid</span>';
          showMessage('Invalid API key. Please check and try again.', 'error');
          return null;
        }
        if (res.status === 429) {
          $('key-status').innerHTML = '<span class="key-status key-invalid">locked</span>';
          showMessage('Too many attempts. Please request a new registration link.', 'error');
          $('verify-btn').disabled = true;
          return null;
        }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Verification failed'); });
        return res.json();
      })
      .then(function (verified) {
        if (!verified) return;
        $('key-status').innerHTML = '<span class="key-status key-valid">verified</span>';

        // 4.25111.98: the model list stays the registry's (rendered from
        // the catalog on load and on every vendor change); the live
        // catalog in this answer is not offered.
        $('model-section').classList.add('visible');
        $('verify-actions').style.display = 'none';

        showMessage('API key verified. Select your model and create your workspace.', 'success');
      })
      .catch(function (err) {
        $('key-status').innerHTML = '<span class="key-status key-invalid">error</span>';
        showMessage(err.message || 'Verification failed', 'error');
      })
      .finally(function () {
        $('verify-btn').disabled = false;
        $('verify-btn').textContent = 'Verify Key';
      });
  }

  // ── Complete Registration ──────────────────────────────────

  function completeRegistration() {
    var orgName = $('reg-org').value.trim();
    var apiKey = $('reg-key') ? $('reg-key').value.trim() : '';
    var modelSelect = $('reg-model');
    var modelId = modelSelect ? modelSelect.value : '';
    var provider = $('reg-provider').value;

    if (vendorComingSoon(provider)) {
      showMessage(vendorNoticeFor(provider), 'error');
      return;
    }
    if (!orgName || orgName.length < 2) {
      showMessage('Organization name is required (min 2 characters)', 'error');
      return;
    }

    // Build payload — key and model are optional when admin-provided
    var payload = {
      token: registrationToken,
      org_name: orgName
    };
    if (apiKey) payload.apiKey = apiKey;
    payload.provider = provider;
    if (modelId) payload.model_id = modelId;

    var btn = $('register-btn');
    btn.disabled = true;
    btn.textContent = 'Creating workspace...';

    fetch(API + '/api/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Registration failed'); });
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.success) throw new Error('Registration failed');

        // Show success panel
        $('step-form').style.display = 'none';
        $('success').style.display = 'block';
        $('success-slug').textContent = data.slug;
        // Land on /app, whose unauthenticated state presents the
        // Login CTA. After sign-in the resolver claims the owner
        // invite and the paywall walks them to Billing. No session
        // is minted here: auth stays with Auth0.
        // 4.25111.78: a registration that began with a purchase on the
        // pricing page is told where to land by the server (the billing
        // page); the value is a same-origin path or ignored.
        var landing = (typeof data.landing === 'string' && /^\/(?!\/)[A-Za-z0-9_\/-]*$/.test(data.landing)) ? data.landing : '/app';
        setTimeout(function () { window.location.href = landing; }, 2500);
      })
      .catch(function (err) {
        showMessage(err.message || 'Registration failed', 'error');
        btn.disabled = false;
        btn.textContent = 'Create Workspace';
      });
  }

  // ── The catalog on the page (4.25111.98, mirrors admin.js) ──

  function providerById(id) {
    for (var i = 0; i < _providers.length; i++) {
      if (_providers[i].id === id) return _providers[i];
    }
    return null;
  }
  function vendorComingSoon(id) {
    var p = providerById(id);
    return !!p && p.textGeneration === 'coming_soon';
  }
  function vendorNoticeFor(id) {
    var p = providerById(id);
    return (p && typeof p.textGenerationNotice === 'string' && p.textGenerationNotice) || 'Support for other language generation models is coming soon.';
  }
  // Vendor options: the catalog's order, label from the catalog, the
  // parked ones marked as the admin card marks them. createElement
  // and textContent only: a label is never markup.
  function renderProviders() {
    var select = $('reg-provider');
    select.innerHTML = '';
    _providers.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = String(p.label || p.id) + (p.textGeneration === 'coming_soon' ? ' (coming soon)' : '');
      select.appendChild(opt);
    });
  }
  // Model options: the registry models of the selected vendor.
  function renderModels(providerId) {
    var select = $('reg-model');
    select.innerHTML = '<option value="">Choose a model...</option>';
    var p = providerById(providerId);
    var models = p && Array.isArray(p.models) ? p.models : [];
    models.forEach(function (m) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string') return;
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      select.appendChild(opt);
    });
  }
  // The parked-vendor note: shown with the vendor's own notice while
  // a coming-soon vendor is selected; Verify and Create are parked
  // with it (the server refuses the vendor again at completion).
  function updateVendorNote() {
    var note = $('reg-vendor-note');
    var selected = $('reg-provider').value;
    var parked = vendorComingSoon(selected) || !selected;
    if (note) {
      note.hidden = !vendorComingSoon(selected);
      note.textContent = vendorComingSoon(selected) ? vendorNoticeFor(selected) : '';
    }
    $('verify-btn').disabled = parked;
    $('register-btn').disabled = parked;
  }

  // ── Bind events ────────────────────────────────────────────

  // Per-vendor key help link; a vendor without a known console keeps
  // the text without a link.
  var KEY_URLS = {
    anthropic: 'https://console.anthropic.com/settings/keys',
    openai: 'https://platform.openai.com/api-keys',
    grok: 'https://console.x.ai/'
  };
  function applyVendorUx() {
    var v = $('reg-provider').value;
    var link = $('key-help-link');
    if (KEY_URLS[v]) { link.href = KEY_URLS[v]; link.style.display = ''; }
    else { link.removeAttribute('href'); link.style.display = 'none'; }
    renderModels(v);
    updateVendorNote();
    // A vendor change asks for a fresh verification.
    $('model-section').classList.remove('visible');
    $('verify-actions').style.display = '';
    $('key-status').innerHTML = '';
  }
  $('reg-provider').addEventListener('change', applyVendorUx);

  $('verify-btn').addEventListener('click', verifyKey);
  $('reg-key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') verifyKey();
  });
  $('register-btn').addEventListener('click', completeRegistration);

  // Start
  initRegistration();
})();
