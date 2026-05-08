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

    $('invite-btn').addEventListener('click', createInvite);
    $('invite-email').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') createInvite();
    });

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
