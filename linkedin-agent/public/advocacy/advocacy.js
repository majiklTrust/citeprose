// =================================================================
// public/advocacy/advocacy.js, participation page (Phase 2 Step 1)
// =================================================================
// Self panel for every role; owner section appears for owners.
// The self surface only ever acts on the signed-in member: the
// APIs derive identity from the session, so this page sends no
// member identifier for self actions.
// =================================================================

(function () {
  var API = window.location.origin;
  var role = null;
  var me = null;

  function $(id) { return document.getElementById(id); }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str === null || str === undefined ? '' : String(str);
    return div.innerHTML;
  }

  function when(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function showMessage(text, type) {
    $('message').innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + '</div>';
  }
  function clearMessage() { $('message').innerHTML = ''; }

  function getJson(path, opts) {
    var o = opts || {};
    o.credentials = 'include';
    o.headers = o.headers || {};
    o.headers['Accept'] = 'application/json';
    return fetch(API + path, o).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  function pill(on, yes, no) {
    return '<span class="pill ' + (on ? 'pill-on' : 'pill-off') + '">' + (on ? yes : no) + '</span>';
  }

  // -- Self panel -------------------------------------------------

  function renderMe() {
    var body = $('me-body');
    var actions = $('me-actions');
    var modeBox = $('me-mode');
    actions.innerHTML = '';
    if (!me || !me.enabled) {
      body.className = 'empty';
      body.textContent = 'Advocacy has not been enabled for your account. A workspace owner can enable you from this page.';
      modeBox.style.display = 'none';
      return;
    }
    var p = me.participation;
    body.className = '';
    body.innerHTML =
      '<div class="row"><span class="k">Enabled</span><span class="v">' + esc(when(p.enabled_at)) + '</span></div>' +
      '<div class="row"><span class="k">Personal LinkedIn</span><span class="v">' + pill(p.connected, 'connected', 'not connected') + '</span></div>' +
      '<div class="row"><span class="k">Consent</span><span class="v">' + esc(p.consent_granted_at ? (when(p.consent_granted_at) + ' (version ' + (p.consent_text_version || '?') + ')') : 'not granted') + '</span></div>' +
      '<div class="row"><span class="k">Mode</span><span class="v"><span class="pill pill-mode">' + esc(p.mode) + '</span></span></div>' +
      '<div class="row"><span class="k">First-degree connections</span><span class="v">' + esc(p.connections_size === null || p.connections_size === undefined ? 'not retrieved' : Number(p.connections_size).toLocaleString()) + '</span></div>';

    if (!p.connected) {
      var a = document.createElement('a');
      a.href = '/auth/linkedin/member';
      var b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = p.consent_granted_at ? 'Reconnect personal LinkedIn' : 'Review consent and connect';
      a.appendChild(b);
      actions.appendChild(a);
      modeBox.style.display = 'none';
    } else {
      var d = document.createElement('button');
      d.className = 'btn btn-danger';
      d.textContent = 'Disconnect my profile';
      d.addEventListener('click', disconnectMe);
      actions.appendChild(d);
      modeBox.style.display = '';
      $('mode-manual').className = 'toggle-btn' + (p.mode === 'manual' ? ' active' : '');
      $('mode-auto').className = 'toggle-btn' + (p.mode === 'auto' ? ' active' : '');
    }
  }

  function loadMe() {
    return getJson('/api/advocacy/me').then(function (r) {
      me = r.ok ? r.body : null;
      renderMe();
    });
  }

  function setMode(mode) {
    clearMessage();
    getJson('/api/advocacy/me/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    }).then(function (r) {
      if (r.ok) {
        showMessage('Mode set to ' + mode + '.', 'success');
        loadMe();
      } else {
        showMessage(r.body.error || 'Could not set mode.', 'error');
      }
    });
  }

  function disconnectMe() {
    clearMessage();
    getJson('/api/advocacy/me/disconnect', { method: 'POST' }).then(function (r) {
      if (r.ok) {
        showMessage('Disconnected. Your stored tokens were wiped (' + (r.body.credentialsWiped || 0) + ' secret(s)); reconnecting requires the full consent flow again.', 'success');
        loadMe();
      } else {
        showMessage(r.body.error || 'Could not disconnect.', 'error');
      }
    });
  }

  // -- Owner section ----------------------------------------------

  function renderMembers(members) {
    var el = $('members-body');
    if (!members || members.length === 0) {
      el.className = 'empty';
      el.textContent = 'No members enabled yet.';
      return;
    }
    var html = '<table><thead><tr><th>Member</th><th>Connected</th><th>Mode</th><th>Consent</th><th>Connections</th><th></th></tr></thead><tbody>';
    members.forEach(function (m) {
      html += '<tr>'
        + '<td title="' + esc(m.auth_sub) + '">' + esc(m.auth_sub) + '</td>'
        + '<td>' + pill(m.connected, 'yes', 'no') + '</td>'
        + '<td>' + esc(m.mode) + '</td>'
        + '<td>' + esc(m.consent_granted_at ? when(m.consent_granted_at) : 'none') + '</td>'
        + '<td>' + esc(m.connections_size === null ? '' : Number(m.connections_size).toLocaleString()) + '</td>'
        + '<td><button class="btn btn-danger" data-sub="' + esc(m.auth_sub) + '">Disable</button></td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    el.className = '';
    el.innerHTML = html;
    el.querySelectorAll('button[data-sub]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleMember(btn.getAttribute('data-sub'), false); });
    });
  }

  function loadMembers() {
    return getJson('/api/advocacy/members').then(function (r) {
      if (r.ok) renderMembers(r.body.members);
      else { $('members-body').className = 'empty'; $('members-body').textContent = 'Failed to load members.'; }
    });
  }

  function toggleMember(sub, enabled) {
    clearMessage();
    getJson('/api/advocacy/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sub: sub, enabled: enabled })
    }).then(function (r) {
      if (r.ok) {
        showMessage(enabled ? 'Member enabled. They must consent and connect themselves.' : 'Member disabled and their stored tokens wiped.', 'success');
        $('enable-sub').value = '';
        loadMembers();
        loadMe();
      } else {
        showMessage(r.body.error || 'Could not update member.', 'error');
      }
    });
  }

  // -- Init --------------------------------------------------------

  fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      $('loading').style.display = 'none';
      if (!data.user || !data.user.role) {
        $('denied').style.display = '';
        return;
      }
      role = data.user.role;
      $('app').style.display = '';
      $('mode-manual').addEventListener('click', function () { setMode('manual'); });
      $('mode-auto').addEventListener('click', function () { setMode('auto'); });
      loadMe();
      if (role === 'owner') {
        $('owner-section').style.display = '';
        $('btn-enable').addEventListener('click', function () {
          var sub = $('enable-sub').value.trim();
          if (!sub) { showMessage('Enter the member auth sub to enable.', 'warn'); return; }
          toggleMember(sub, true);
        });
        loadMembers();
      }
    })
    .catch(function () {
      $('loading').style.display = 'none';
      $('denied').style.display = '';
    });
})();
