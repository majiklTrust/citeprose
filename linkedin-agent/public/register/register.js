// ═══════════════════════════════════════════════════════════════
// public/register/register.js — Registration form logic
// ═══════════════════════════════════════════════════════════════
// Token-based authentication. No session cookie. The registration
// token in the URL fragment is the sole authorization.
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;
  var registrationToken = null;

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
      $('loading').style.display = 'none';
      $('invalid').style.display = 'block';
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

        // If admin pre-provided the API key, hide key section
        if (data.keyProvided) {
          $('reg-key').parentElement.style.display = 'none';
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
    if (!key) {
      showMessage('Please enter your Anthropic API key', 'error');
      return;
    }

    $('verify-btn').disabled = true;
    $('verify-btn').textContent = 'Verifying...';
    $('key-status').innerHTML = '<span class="key-status key-checking">checking...</span>';

    fetch(API + '/api/register/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: registrationToken, api_key: key, provider: $('reg-provider').value })
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
      .then(function (data) {
        if (!data) return;
        $('key-status').innerHTML = '<span class="key-status key-valid">verified</span>';

        // Populate model selector
        var select = $('reg-model');
        select.innerHTML = '<option value="">Choose a model...</option>';
        (data.models || []).forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          select.appendChild(opt);
        });

        // Show model section
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
    var customModel = document.getElementById('reg-model-custom');
    var modelId = customModel ? customModel.value.trim() : modelSelect ? modelSelect.value : '';

    if (!orgName || orgName.length < 2) {
      showMessage('Organization name is required (min 2 characters)', 'error');
      return;
    }

    // Build payload — key and model are optional when admin-provided
    var payload = {
      token: registrationToken,
      org_name: orgName
    };
    if (apiKey) payload.api_key = apiKey;
    payload.provider = $('reg-provider').value;
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
        // Workspace established: hand off to Billing (auth will
        // interpose its login on the way when needed).
        setTimeout(function () { window.location.href = '/app/billing/'; }, 1500);
      })
      .catch(function (err) {
        showMessage(err.message || 'Registration failed', 'error');
        btn.disabled = false;
        btn.textContent = 'Create Workspace';
      });
  }

  // ── Bind events ────────────────────────────────────────────

  // Per-vendor key help. Custom has no target and needs no
  // verification: the model becomes free entry and Create is
  // enabled directly.
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
    var isCustom = v === 'custom';
    $('verify-actions').style.display = isCustom ? 'none' : '';
    if (isCustom) {
      $('model-section').classList.add('visible');
      var sel = $('reg-model');
      if (!document.getElementById('reg-model-custom')) {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.id = 'reg-model-custom';
        inp.placeholder = 'Model identifier for your endpoint';
        sel.parentNode.insertBefore(inp, sel);
      }
      sel.style.display = 'none';
      $('register-btn').disabled = false;
    } else {
      var custom = document.getElementById('reg-model-custom');
      if (custom) custom.remove();
      $('reg-model').style.display = '';
      $('model-section').classList.remove('visible');
    }
  }
  $('reg-provider').addEventListener('change', applyVendorUx);
  applyVendorUx();

  $('verify-btn').addEventListener('click', verifyKey);
  $('reg-key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') verifyKey();
  });
  $('register-btn').addEventListener('click', completeRegistration);

  // Start
  initRegistration();
})();
