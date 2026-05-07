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
    section.innerHTML = [
      '<h2 style="margin-top:2rem;">New Tenant Registration</h2>',
      '<p style="color:#888; font-size:0.85rem; margin-bottom:1rem;">Create a registration invite for a new tenant. The link expires after the configured TTL.</p>',
      '<div class="invite-form">',
      '  <input type="email" id="reg-invite-email" placeholder="Email address">',
      '  <button class="btn btn-primary" id="reg-invite-btn">Create Registration Invite</button>',
      '</div>',
      '<div id="reg-result"></div>'
    ].join('\n');
    return section;
  }

  function createRegistrationInvite() {
    var email = $('reg-invite-email').value.trim();
    if (!email || !email.includes('@')) {
      showMessage('Valid email address required', 'error');
      return;
    }

    $('reg-invite-btn').disabled = true;
    $('reg-invite-btn').textContent = 'Creating...';

    fetch(API + '/api/register/invite', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
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
          '<div style="margin-top:1rem; padding:1rem; background:#12141c; border:1px solid #2a2d3a; border-radius:8px;">',
          '  <p style="font-weight:600; margin-bottom:0.5rem; color:#3b82f6;">Registration Link</p>',
          '  <input type="text" readonly value="' + escapeHtml(data.registerUrl) + '" style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.8rem; margin-bottom:0.75rem;" onclick="this.select()">',
          '  <p style="font-weight:600; margin-bottom:0.5rem; color:#3b82f6;">Email Template (copy &amp; paste)</p>',
          '  <textarea readonly rows="8" style="width:100%; padding:0.4rem; background:#0f1117; border:1px solid #2a2d3a; color:#e0e0e0; border-radius:4px; font-size:0.8rem; resize:vertical;" onclick="this.select()">' + escapeHtml(data.emailTemplate) + '</textarea>',
          '  <p style="font-size:0.75rem; color:#666; margin-top:0.5rem;">Expires: ' + escapeHtml(expires) + '</p>',
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

    // Platform admin: show registration section
    if (_isPlatformAdmin) {
      var section = buildRegistrationSection();
      $('admin').appendChild(section);
      $('reg-invite-btn').addEventListener('click', createRegistrationInvite);
      $('reg-invite-email').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') createRegistrationInvite();
      });
    }
  });
})();
