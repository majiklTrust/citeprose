// ═══════════════════════════════════════════════════════════════
// public/admin/admin.js — User management page logic
// ═══════════════════════════════════════════════════════════════
// Standalone vanilla JS. No React, no build system.
// Checks role + devBypass on load. Redirects if not owner.
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;

  function $(id) { return document.getElementById(id); }

  function showMessage(text, type) {
    var el = $('message');
    el.innerHTML = '<div class="msg msg-' + type + '">' + escapeHtml(text) + '</div>';
    setTimeout(function () { el.innerHTML = ''; }, 5000);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function roleBadge(role) {
    return '<span class="role-badge role-' + escapeHtml(role) + '">' + escapeHtml(role) + '</span>';
  }

  // ── Access check ───────────────────────────────────────────

  var _isPlatformAdmin = false;

  function checkAccess() {
    return fetch(API + '/api/status', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var user = data.user;
        // Block if: no user, not owner, or dev bypass active
        if (!user || user.role !== 'owner') {
          return false;
        }
        // Check devBypass — the status response includes it
        // when the middleware sets req.devBypass
        if (data.devBypass) {
          return false;
        }
        // Capture platform admin flag
        _isPlatformAdmin = !!user.isPlatformAdmin;
        return true;
      })
      .catch(function () { return false; });
  }

  // ── Members ────────────────────────────────────────────────

  function loadMembers() {
    fetch(API + '/api/admin/members', { credentials: 'include' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var members = data.members || [];
        if (members.length === 0) {
          $('members-list').innerHTML = '<span class="empty">No members</span>';
          return;
        }
        var html = '<table><thead><tr><th>User</th><th>Role</th><th>Actions</th></tr></thead><tbody>';
        members.forEach(function (m) {
          html += '<tr>';
          html += '<td>' + escapeHtml(m.auth_sub) + '</td>';
          html += '<td>' + roleBadge(m.role) + '</td>';
          html += '<td>';
          if (m.role !== 'owner') {
            html += '<select data-member-id="' + escapeHtml(m.id) + '" class="role-select">';
            html += '<option value="editor"' + (m.role === 'editor' ? ' selected' : '') + '>Editor</option>';
            html += '<option value="viewer"' + (m.role === 'viewer' ? ' selected' : '') + '>Viewer</option>';
            html += '</select> ';
            html += '<button class="btn btn-danger btn-remove" data-member-id="' + escapeHtml(m.id) + '">Remove</button>';
          } else {
            html += '<em>Owner</em>';
          }
          html += '</td></tr>';
        });
        html += '</tbody></table>';
        $('members-list').innerHTML = html;

        // Bind role change handlers
        var selects = document.querySelectorAll('.role-select');
        selects.forEach(function (sel) {
          sel.addEventListener('change', function () {
            changeRole(sel.dataset.memberId, sel.value);
          });
        });

        // Bind remove handlers
        var removeButtons = document.querySelectorAll('.btn-remove');
        removeButtons.forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (confirm('Remove this member? They will lose access to the workspace.')) {
              removeMember(btn.dataset.memberId);
            }
          });
        });
      })
      .catch(function (err) {
        $('members-list').innerHTML = '<span class="msg msg-error">Failed to load members</span>';
      });
  }

  function changeRole(memberId, newRole) {
    fetch(API + '/api/admin/members/' + memberId, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
        showMessage('Role updated', 'success');
        loadMembers();
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  function removeMember(memberId) {
    fetch(API + '/api/admin/members/' + memberId, {
      method: 'DELETE',
      credentials: 'include'
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
        showMessage('Member removed', 'success');
        loadMembers();
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  // ── Invites ────────────────────────────────────────────────

  function loadInvites() {
    fetch(API + '/api/admin/invites', { credentials: 'include' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var invites = data.invites || [];
        if (invites.length === 0) {
          $('invites-list').innerHTML = '<span class="empty">No pending invites</span>';
          return;
        }
        var html = '<table><thead><tr><th>Email</th><th>Role</th><th>Invited</th><th>Actions</th></tr></thead><tbody>';
        invites.forEach(function (inv) {
          var date = new Date(inv.created_at).toLocaleDateString();
          html += '<tr>';
          html += '<td>' + escapeHtml(inv.email) + '</td>';
          html += '<td>' + roleBadge(inv.role) + '</td>';
          html += '<td>' + escapeHtml(date) + '</td>';
          html += '<td><button class="btn btn-danger btn-revoke" data-invite-id="' + escapeHtml(inv.id) + '">Revoke</button></td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        $('invites-list').innerHTML = html;

        var revokeButtons = document.querySelectorAll('.btn-revoke');
        revokeButtons.forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (confirm('Revoke this invite?')) {
              revokeInvite(btn.dataset.inviteId);
            }
          });
        });
      })
      .catch(function () {
        $('invites-list').innerHTML = '<span class="msg msg-error">Failed to load invites</span>';
      });
  }

  function createInvite() {
    var email = $('invite-email').value.trim();
    var role = $('invite-role').value;
    if (!email) {
      showMessage('Email address is required', 'error');
      return;
    }
    fetch(API + '/api/admin/invites', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, role: role })
    })
      .then(function (res) {
        if (res.status === 409) throw new Error('A pending invite already exists for this email');
        if (res.status === 400) return res.json().then(function (d) { throw new Error(d.error || 'Invalid input'); });
        if (!res.ok) throw new Error('Failed to create invite');
        showMessage('Invite sent to ' + email, 'success');
        $('invite-email').value = '';
        loadInvites();
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  function revokeInvite(inviteId) {
    fetch(API + '/api/admin/invites/' + inviteId, {
      method: 'DELETE',
      credentials: 'include'
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to revoke invite');
        showMessage('Invite revoked', 'success');
        loadInvites();
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  // ── AI Model Provider (owner) ───────────────────────────────
  // Vendor and model options come from the registry-backed
  // /api/admin/ai-config endpoint. Client-side key verification
  // mirrors the existing verifyAdminKey() pattern and is UX only:
  // the server re-validates against the selected vendor before
  // anything is stored.

  var _aiProviders = [];
  var _aiCurrent = null;
  var _aiKeyValidated = false;

  function aiProviderById(id) {
    for (var i = 0; i < _aiProviders.length; i++) {
      if (_aiProviders[i].id === id) return _aiProviders[i];
    }
    return null;
  }

  function renderAiModels(providerId, selectedModel) {
    var select = $('ai-model');
    select.innerHTML = '';
    var provider = aiProviderById(providerId);
    var models = (provider && provider.models) || [];
    if (models.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models registered for this vendor';
      select.appendChild(opt);
      return;
    }
    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      if (selectedModel && selectedModel === m.id) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function renderAiCurrent() {
    if (!_aiCurrent) { $('ai-current').textContent = ''; return; }
    var keyNote = _aiCurrent.hasKey ? 'key stored' : 'no key stored yet';
    $('ai-current').textContent = 'Current: ' + (_aiCurrent.provider || '(none)') +
      ' / ' + (_aiCurrent.model || '(no model)') + ' (' + keyNote + ')';
  }

  function loadAiConfig() {
    fetch(API + '/api/admin/ai-config', { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load AI configuration');
        return res.json();
      })
      .then(function (data) {
        _aiProviders = data.providers || [];
        _aiCurrent = data.current || null;
        var select = $('ai-provider');
        select.innerHTML = '';
        _aiProviders.forEach(function (p) {
          var opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.label || p.id;
          if (_aiCurrent && _aiCurrent.provider === p.id) opt.selected = true;
          select.appendChild(opt);
        });
        var activeProvider = (select.value || (_aiProviders[0] && _aiProviders[0].id)) || '';
        renderAiModels(activeProvider, _aiCurrent && _aiCurrent.model);
        renderAiCurrent();
      })
      .catch(function () {
        $('ai-current').innerHTML = '<span class="msg msg-error">Failed to load AI configuration</span>';
      });
  }

  function verifyAiKey() {
    var key = $('ai-key').value.trim();
    var provider = $('ai-provider').value;
    if (!key) {
      showMessage('Enter the vendor API key to verify', 'error');
      return;
    }
    $('ai-verify-btn').disabled = true;
    $('ai-verify-btn').textContent = 'Verifying...';
    $('ai-key-status').innerHTML = '<span class="ai-status-wait">checking...</span>';

    fetch(API + '/api/register/validate-key', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider, api_key: key })
    })
      .then(function (res) {
        if (res.status === 401) {
          $('ai-key-status').innerHTML = '<span class="ai-status-bad">invalid key for this vendor</span>';
          _aiKeyValidated = false;
          return null;
        }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Verification failed'); });
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        $('ai-key-status').innerHTML = '<span class="ai-status-ok">verified</span>';
        _aiKeyValidated = true;
      })
      .catch(function (err) {
        $('ai-key-status').innerHTML = '<span class="ai-status-bad">' + escapeHtml(err.message) + '</span>';
        _aiKeyValidated = false;
      })
      .finally(function () {
        $('ai-verify-btn').disabled = false;
        $('ai-verify-btn').textContent = 'Verify Key';
      });
  }

  function saveAiConfig() {
    var provider = $('ai-provider').value;
    var model = $('ai-model').value;
    var key = $('ai-key').value.trim();
    if (!provider || !model) {
      showMessage('Choose a vendor and model', 'error');
      return;
    }
    if (key && !_aiKeyValidated) {
      showMessage('Please verify the API key first', 'error');
      return;
    }
    var payload = { provider: provider, model: model };
    if (key) payload.api_key = key;

    $('ai-save-btn').disabled = true;
    $('ai-save-btn').textContent = 'Saving...';

    fetch(API + '/api/admin/ai-config', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to save'); });
        return res.json();
      })
      .then(function () {
        showMessage('AI configuration saved', 'success');
        $('ai-key').value = '';
        $('ai-key-status').innerHTML = '';
        _aiKeyValidated = false;
        loadAiConfig();
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('ai-save-btn').disabled = false;
        $('ai-save-btn').textContent = 'Save';
      });
  }

  // ── Image render budget ─────────────────────────────────────

  function renderImageBudget(status) {
    var el = $('img-budget-current');
    if (!status || typeof status !== 'object') { el.textContent = ''; return; }
    if (!status.enabled) {
      el.textContent = 'Current: generation disabled (budget not set)';
      $('img-budget-input').value = '';
      return;
    }
    var budget = Number(status.budgetUsd || 0);
    var spent = Number(status.spentUsd || 0);
    var remaining = Number(status.remainingUsd || 0);
    el.textContent = 'Current: $' + budget.toFixed(2) + ' per cycle (spent $' +
      spent.toFixed(2) + ', remaining $' + remaining.toFixed(2) + ')';
    $('img-budget-input').value = String(budget);
  }

  function loadImageBudget() {
    fetch(API + '/api/admin/image-budget', { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load image budget');
        return res.json();
      })
      .then(function (data) { renderImageBudget(data); })
      .catch(function () {
        $('img-budget-current').innerHTML = '<span class="msg msg-error">Failed to load image budget</span>';
      });
  }

  function saveImageBudget() {
    var raw = $('img-budget-input').value.trim();
    if (raw === '') { showMessage('Enter a budget amount in dollars', 'error'); return; }
    var dollars = Number(raw);
    if (!isFinite(dollars) || dollars < 0 || dollars > 1000000) {
      showMessage('Budget must be a dollar amount between 0 and 1,000,000', 'error');
      return;
    }
    $('img-budget-save-btn').disabled = true;
    $('img-budget-save-btn').textContent = 'Saving...';
    fetch(API + '/api/admin/image-budget', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dollars: dollars })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to save'); });
        return res.json();
      })
      .then(function (data) {
        showMessage('Image budget saved', 'success');
        renderImageBudget(data);
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('img-budget-save-btn').disabled = false;
        $('img-budget-save-btn').textContent = 'Save';
      });
  }

  // ── Brand palette (AI images) ───────────────────────────────

  function renderImagePalette(palette) {
    var el = $('img-palette-current');
    if (!palette) {
      el.textContent = 'Current: no palette set';
      $('img-palette-input').value = '';
      return;
    }
    el.textContent = 'Current: ' + palette;
    $('img-palette-input').value = palette;
  }

  function loadImagePalette() {
    fetch(API + '/api/admin/image-palette', { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load the brand palette');
        return res.json();
      })
      .then(function (data) { renderImagePalette(data.palette); })
      .catch(function () {
        $('img-palette-current').innerHTML = '<span class="msg msg-error">Failed to load the brand palette</span>';
      });
  }

  function saveImagePalette() {
    var raw = $('img-palette-input').value;
    if (raw.length > 240) { showMessage('Palette must be 240 characters or fewer', 'error'); return; }
    if (/[{}]/.test(raw)) { showMessage('Palette cannot contain braces', 'error'); return; }
    $('img-palette-save-btn').disabled = true;
    $('img-palette-save-btn').textContent = 'Saving...';
    fetch(API + '/api/admin/image-palette', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palette: raw.trim() })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to save'); });
        return res.json();
      })
      .then(function (data) {
        showMessage('Brand palette saved', 'success');
        renderImagePalette(data.palette);
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('img-palette-save-btn').disabled = false;
        $('img-palette-save-btn').textContent = 'Save';
      });
  }

  // ── Image destination (Phase 6) ─────────────────────────────

  function loadImageDestination() {
    fetch(API + '/api/admin/image-destination', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw new Error('load failed'); return res.json(); })
      .then(function (d) {
        var idn = d.hasCredentials ? 'stored tenant credentials' : "the server's ambient identity";
        if (d.destination) {
          $('img-dest-input').value = d.destination;
          $('img-dest-current').textContent = 'Current destination: ' + d.destination + ' (identity: ' + idn + ')';
        } else {
          $('img-dest-current').textContent = 'No tenant destination set: the platform default applies.';
        }
      })
      .catch(function () {
        $('img-dest-current').innerHTML = '<span class="msg msg-error">Failed to load the image destination</span>';
      });
  }

  function saveImageDestination() {
    var v = $('img-dest-input').value.trim();
    if (!v) { showMessage('Paste a destination first, or use Clear.', 'error'); return; }
    $('img-dest-save-btn').disabled = true;
    $('img-dest-save-btn').textContent = 'Verifying live...';
    fetch(API + '/api/admin/image-destination', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: v,
        accessKeyId: $('img-dest-key-id').value.trim() || null,
        secretAccessKey: $('img-dest-secret').value.trim() || null
      })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Verification failed'); });
        return res.json();
      })
      .then(function (d) {
        $('img-dest-secret').value = '';   // the secret lives in the vault now, not in the page
        showMessage('Destination verified: wrote and read back at s3://' + d.bucket + '/' + (d.prefix || ''), 'success');
        $('img-dest-current').textContent = 'Current destination: ' + d.destination + ' (verified live, identity: ' + (d.hasCredentials ? 'stored tenant credentials' : 'ambient') + ')';
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('img-dest-save-btn').disabled = false;
        $('img-dest-save-btn').textContent = 'Verify and save destination';
      });
  }

  function clearImageDestination() {
    fetch(API + '/api/admin/image-destination', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: null })
    })
      .then(function (res) { if (!res.ok) throw new Error('Clear failed'); return res.json(); })
      .then(function () {
        $('img-dest-input').value = '';
        $('img-dest-key-id').value = '';
        $('img-dest-secret').value = '';
        $('img-dest-current').textContent = 'No tenant destination set: the platform default applies.';
        showMessage('Destination and stored credentials cleared', 'success');
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  // ── Image model selection ───────────────────────────────────

  var _imgModelCatalog = [];

  function renderImageModelOptions(providerId, selectedModel) {
    var entry = null;
    for (var i = 0; i < _imgModelCatalog.length; i++) {
      if (_imgModelCatalog[i].id === providerId) { entry = _imgModelCatalog[i]; break; }
    }
    var sel = $('img-model-select');
    sel.innerHTML = '';
    ((entry && entry.models) || []).forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label || m.id;
      if (selectedModel && selectedModel === m.id) o.selected = true;
      sel.appendChild(o);
    });
  }

  function loadImageModel() {
    fetch(API + '/api/admin/image-model', { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load the image model selection');
        return res.json();
      })
      .then(function (data) {
        _imgModelCatalog = data.providers || [];
        var current = data.current || {};
        var fallback = data.registryDefault || {};
        var provider = current.provider || fallback.provider || '';
        var psel = $('img-model-provider');
        psel.innerHTML = '';
        _imgModelCatalog.forEach(function (p) {
          var o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.label || p.id;
          if (p.id === provider) o.selected = true;
          psel.appendChild(o);
        });
        renderImageModelOptions(psel.value, current.model || fallback.model);
        $('img-model-current').textContent = current.provider
          ? ('Current: ' + current.provider + ' / ' + (current.model || '(default)'))
          : 'Current: not configured yet (image generation refuses until saved)';
      })
      .catch(function () {
        $('img-model-current').innerHTML = '<span class="msg msg-error">Failed to load the image model selection</span>';
      });
  }

  function saveImageModel() {
    var provider = $('img-model-provider').value;
    var model = $('img-model-select').value;
    $('img-model-save-btn').disabled = true;
    $('img-model-save-btn').textContent = 'Saving...';
    fetch(API + '/api/admin/image-model', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider, model: model })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to save'); });
        return res.json();
      })
      .then(function (data) {
        showMessage('Image model saved', 'success');
        $('img-model-current').textContent = 'Current: ' + data.provider + ' / ' + data.model;
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('img-model-save-btn').disabled = false;
        $('img-model-save-btn').textContent = 'Save';
      });
  }

  // ── Image storage backend ───────────────────────────────────

  function renderImageStorage(backend) {
    $('img-storage-current').textContent = 'Current: ' + (backend === 's3' ? 'S3 object storage' : 'Database (built in)');
    $('img-storage-select').value = backend === 's3' ? 's3' : 'db';
  }

  function loadImageStorage() {
    fetch(API + '/api/admin/image-storage', { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load the image storage backend');
        return res.json();
      })
      .then(function (data) { renderImageStorage(data.backend); })
      .catch(function () {
        $('img-storage-current').innerHTML = '<span class="msg msg-error">Failed to load the image storage backend</span>';
      });
  }

  function saveImageStorage() {
    var backend = $('img-storage-select').value;
    $('img-storage-save-btn').disabled = true;
    $('img-storage-save-btn').textContent = 'Saving...';
    fetch(API + '/api/admin/image-storage', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: backend })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to save'); });
        return res.json();
      })
      .then(function (data) {
        showMessage('Image storage backend saved', 'success');
        renderImageStorage(data.backend);
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('img-storage-save-btn').disabled = false;
        $('img-storage-save-btn').textContent = 'Save';
      });
  }

  // ── Tenant Registration (platform admin only) ───────────────

  function buildRegistrationSection() {
    var section = document.createElement('div');
    section.id = 'registration-section';
    section.className = 'section';
    section.innerHTML = [
      '<h2>New Tenant Registration</h2>',
      '<p style="color:#888; font-size:0.85rem; margin-bottom:1rem;">Create a registration invite for a new tenant. The link expires after the configured TTL.</p>',
      '<div class="invite-form">',
      '  <input type="email" id="reg-invite-email" placeholder="Email address">',
      '  <div style="margin-top:0.75rem;">',
      '    <label style="display:flex; align-items:center; gap:0.5rem; cursor:pointer; font-size:0.85rem; color:#aaa;">',
      '      <input type="checkbox" id="reg-provide-key">',
      '      Provide Anthropic API key for this tenant',
      '    </label>',
      '  </div>',
      '  <div id="reg-key-section" style="display:none; margin-top:0.75rem; padding:0.75rem; background:#12141c; border:1px solid #2a2d3a; border-radius:6px;">',
      '    <div style="margin-bottom:0.5rem;">',
      '      <label style="display:block; font-size:0.75rem; color:#888; margin-bottom:0.2rem;">API Key</label>',
      '      <input type="password" id="reg-admin-key" placeholder="sk-ant-..." style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.85rem;">',
      '    </div>',
      '    <button class="btn btn-secondary" id="reg-verify-key-btn" style="margin-bottom:0.5rem;">Verify Key</button>',
      '    <span id="reg-key-status" style="margin-left:0.5rem; font-size:0.8rem;"></span>',
      '    <div id="reg-model-section" style="display:none; margin-top:0.5rem;">',
      '      <label style="display:block; font-size:0.75rem; color:#888; margin-bottom:0.2rem;">Model</label>',
      '      <select id="reg-admin-model" style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.85rem;">',
      '        <option value="">Choose a model...</option>',
      '      </select>',
      '    </div>',
      '  </div>',
      '  <button class="btn btn-primary" id="reg-invite-btn" style="margin-top:0.75rem;">Create Registration Invite</button>',
      '</div>',
      '<div id="reg-result"></div>'
    ].join('\n');
    return section;
  }

  var _adminKeyValidated = false;

  function verifyAdminKey() {
    var key = $('reg-admin-key').value.trim();
    if (!key) return;

    $('reg-verify-key-btn').disabled = true;
    $('reg-verify-key-btn').textContent = 'Verifying...';
    $('reg-key-status').innerHTML = '<span style="color:#f59e0b;">checking...</span>';

    fetch(API + '/api/register/validate-key', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '_admin_validation_', api_key: key })
    })
      .then(function (res) {
        if (res.status === 401) {
          $('reg-key-status').innerHTML = '<span style="color:#ef4444;">invalid key</span>';
          _adminKeyValidated = false;
          return null;
        }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error); });
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        $('reg-key-status').innerHTML = '<span style="color:#10b981;">verified</span>';
        _adminKeyValidated = true;

        var select = $('reg-admin-model');
        select.innerHTML = '<option value="">Choose a model...</option>';
        (data.models || []).forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          select.appendChild(opt);
        });
        $('reg-model-section').style.display = 'block';
      })
      .catch(function (err) {
        $('reg-key-status').innerHTML = '<span style="color:#ef4444;">' + escapeHtml(err.message) + '</span>';
        _adminKeyValidated = false;
      })
      .finally(function () {
        $('reg-verify-key-btn').disabled = false;
        $('reg-verify-key-btn').textContent = 'Verify Key';
      });
  }

  function createRegistrationInvite() {
    var email = $('reg-invite-email').value.trim();
    if (!email || !email.includes('@')) {
      showMessage('Valid email address required', 'error');
      return;
    }

    var provideKey = $('reg-provide-key').checked;
    var payload = { email: email };

    if (provideKey) {
      var key = $('reg-admin-key').value.trim();
      var model = $('reg-admin-model').value;
      if (!key || !_adminKeyValidated) {
        showMessage('Please verify the API key first', 'error');
        return;
      }
      if (!model) {
        showMessage('Please select a model', 'error');
        return;
      }
      payload.api_key = key;
      payload.model_id = model;
    }

    $('reg-invite-btn').disabled = true;
    $('reg-invite-btn').textContent = 'Creating...';

    fetch(API + '/api/register/invite', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
        return res.json();
      })
      .then(function (data) {
        $('reg-invite-email').value = '';
        showMessage('Registration invite created for ' + escapeHtml(data.email), 'success');

        var expires = new Date(data.expiresAt).toLocaleString();
        var resultHtml = [
          '<div style="margin-top:1rem; padding:1.25rem; background:#12141c; border:1px solid #2a2d3a; border-radius:8px;">',
          '  <p style="font-weight:600; margin-bottom:1rem; color:#10b981; font-size:0.95rem;">Invite Created — Copy the fields below into your email client</p>',
          '  <div style="margin-bottom:0.75rem;">',
          '    <label style="display:block; font-size:0.75rem; color:#888; margin-bottom:0.2rem; font-weight:600;">To</label>',
          '    <input type="text" readonly value="' + escapeHtml(data.email) + '" style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.85rem;" onclick="this.select()">',
          '  </div>',
          '  <div style="margin-bottom:0.75rem;">',
          '    <label style="display:block; font-size:0.75rem; color:#888; margin-bottom:0.2rem; font-weight:600;">Subject</label>',
          '    <input type="text" readonly value="' + escapeHtml(data.emailSubject) + '" style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.85rem;" onclick="this.select()">',
          '  </div>',
          '  <div style="margin-bottom:0.75rem;">',
          '    <label style="display:block; font-size:0.75rem; color:#888; margin-bottom:0.2rem; font-weight:600;">Body</label>',
          '    <textarea readonly rows="12" style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.85rem; resize:vertical; line-height:1.5;" onclick="this.select()">' + escapeHtml(data.emailBody) + '</textarea>',
          '  </div>',
          '  <p style="font-size:0.75rem; color:#666;">Expires: ' + escapeHtml(expires) + '</p>',
          '</div>'
        ].join('\n');
        $('reg-result').innerHTML = resultHtml;
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('reg-invite-btn').disabled = false;
        $('reg-invite-btn').textContent = 'Create Registration Invite';
      });
  }

  // ── Init ───────────────────────────────────────────────────

  checkAccess().then(function (allowed) {
    $('loading').style.display = 'none';
    if (!allowed) {
      $('denied').style.display = 'block';
      setTimeout(function () { window.location.href = '/app'; }, 3000);
      return;
    }
    $('admin').style.display = 'block';
    loadMembers();
    loadInvites();
    loadAiConfig();
    loadImageBudget();
    loadImagePalette();
    loadImageStorage();
    loadImageModel();
    loadImageDestination();
    loadSpendSummary();

    $('invite-btn').addEventListener('click', createInvite);
    $('invite-email').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') createInvite();
    });

    $('ai-provider').addEventListener('change', function () {
      // Vendor changed: repopulate models from the registry data
      // and invalidate any previous key verification.
      renderAiModels(this.value, _aiCurrent && _aiCurrent.provider === this.value ? _aiCurrent.model : null);
      _aiKeyValidated = false;
      $('ai-key-status').innerHTML = '';
    });
    $('ai-key').addEventListener('input', function () {
      _aiKeyValidated = false;
      $('ai-key-status').innerHTML = '';
    });
    $('ai-verify-btn').addEventListener('click', verifyAiKey);
    $('ai-save-btn').addEventListener('click', saveAiConfig);
    $('img-budget-save-btn').addEventListener('click', saveImageBudget);
    $('img-palette-save-btn').addEventListener('click', saveImagePalette);
    $('img-storage-save-btn').addEventListener('click', saveImageStorage);
    $('img-model-save-btn').addEventListener('click', saveImageModel);
    $('img-model-provider').addEventListener('change', function () { renderImageModelOptions(this.value, null); });
    $('img-dest-save-btn').addEventListener('click', saveImageDestination);
    $('img-dest-clear-btn').addEventListener('click', clearImageDestination);

    // Platform admin: show registration section above Invite User
    if (_isPlatformAdmin) {
      var section = buildRegistrationSection();
      var inviteSection = $('invite-email').closest('.section');
      if (inviteSection) {
        inviteSection.parentElement.insertBefore(section, inviteSection);
      } else {
        $('admin').appendChild(section);
      }
      $('reg-invite-btn').addEventListener('click', createRegistrationInvite);
      $('reg-invite-email').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') createRegistrationInvite();
      });
      $('reg-provide-key').addEventListener('change', function () {
        $('reg-key-section').style.display = this.checked ? 'block' : 'none';
        if (!this.checked) {
          _adminKeyValidated = false;
          $('reg-admin-key').value = '';
          $('reg-key-status').innerHTML = '';
          $('reg-model-section').style.display = 'none';
        }
      });
      $('reg-verify-key-btn').addEventListener('click', verifyAdminKey);
    }
  });
})();

function loadSpendSummary() {
  fetch(API + '/api/admin/spend-summary', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) { $('spend-by-provider').textContent = 'Spend data unavailable.'; return; }
      var money = function (v) { return v === null || v === undefined ? 'n/a' : '$' + Number(v).toFixed(4); };
      if (d.activeTrials && d.activeTrials.length) {
        var tr = d.activeTrials[0];
        var pill = $('spend-trial-pill');
        pill.style.display = 'block';
        pill.innerHTML = '<strong>Platform Trial Key Active</strong> (' + tr.provider + '): ' +
          money(tr.key_spent) + ' of ' + money(tr.max_spend_usd) + ' used; ends ' + new Date(tr.ends_at).toLocaleDateString() + '.';
      }
      var rows = (d.byProvider || []).map(function (p) {
        return '<div>' + p.provider + ' (' + p.key_source + '): ' + p.calls + ' calls, ' +
          p.input_tokens + ' in / ' + p.output_tokens + ' out tokens, ' + money(p.cost_estimate_usd) + ' est.</div>';
      }).join('');
      $('spend-by-provider').innerHTML = rows || '<div>No spend recorded in the last 30 days.</div>';
      var recent = (d.recent || []).map(function (a) {
        return '<div>' + new Date(a.created_at).toLocaleString() + ' \u00B7 ' + a.workflow +
          (a.label ? (': ' + a.label) : '') + ' \u00B7 ' + a.calls + ' calls \u00B7 ' + money(a.cost_estimate_usd) + ' est.</div>';
      }).join('');
      $('spend-recent').innerHTML = recent || '<div>No activity yet.</div>';
    })
    .catch(function () { $('spend-by-provider').textContent = 'Spend data unavailable.'; });
}
