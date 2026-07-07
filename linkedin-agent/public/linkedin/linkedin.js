// =================================================================
// public/linkedin/linkedin.js, connection settings page (owner)
// =================================================================
// Talks only to /api/linkedin/* (manage_linkedin-gated) and
// /api/status for the role check. Token values flow one way: into
// the POST body over the session; nothing here ever renders one.
// =================================================================

(function () {
  var API = window.location.origin;

  function $(id) { return document.getElementById(id); }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str === null || str === undefined ? '' : String(str);
    return div.innerHTML;
  }

  function showMessage(text, type) {
    $('message').innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + '</div>';
  }
  function clearMessage() { $('message').innerHTML = ''; }

  function whenEpoch(sec) {
    var n = parseInt(sec, 10);
    if (!n || n <= 0) return 'not bookmarked';
    var d = new Date(n * 1000);
    return isNaN(d.getTime()) ? 'not bookmarked' : d.toLocaleString();
  }

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

  var conn = null;

  function renderStatus() {
    var el = $('status-body');
    if (!conn) { el.className = 'empty'; el.textContent = 'Status unavailable.'; return; }
    function pill(on, yes, no) {
      return '<span class="pill ' + (on ? 'pill-on' : 'pill-off') + '">' + (on ? yes : no) + '</span>';
    }
    el.className = '';
    el.innerHTML =
      '<div class="row"><span class="k">LinkedIn</span><span class="v">' + pill(conn.linkedinConnected, 'connected', 'not connected') + '</span></div>' +
      '<div class="row"><span class="k">Refresh token on file</span><span class="v">' + pill(conn.hasRefreshToken, 'yes', 'no') + '</span></div>' +
      '<div class="row"><span class="k">Organization page</span><span class="v">' + pill(conn.orgConfigured, 'configured', 'not configured') + '</span></div>' +
      '<div class="row"><span class="k">Person URN</span><span class="v" title="' + esc(conn.personUrn) + '">' + esc(conn.personUrn || 'not stored') + '</span></div>' +
      '<div class="row"><span class="k">Org URN</span><span class="v" title="' + esc(conn.orgUrn) + '">' + esc(conn.orgUrn || 'not stored') + '</span></div>' +
      '<div class="row"><span class="k">Access token expiry</span><span class="v">' + esc(whenEpoch(conn.accessTokenExpiresAt)) + '</span></div>' +
      '<div class="row"><span class="k">Refresh token expiry</span><span class="v">' + esc(whenEpoch(conn.refreshTokenExpiresAt)) + '</span></div>';

    $('target-personal').className = 'toggle-btn' + (conn.publishTarget === 'personal' ? ' active' : '');
    $('target-organization').className = 'toggle-btn' + (conn.publishTarget === 'organization' ? ' active' : '');
    $('target-organization').disabled = !conn.orgConfigured;
    $('target-organization').title = conn.orgConfigured ? '' : 'Connect an organization page first';

    var orgBody = $('org-body');
    if (conn.orgConfigured) {
      orgBody.className = '';
      orgBody.innerHTML = '<div class="row"><span class="k">Connected org</span><span class="v">' + esc(conn.orgUrn) + '</span></div>';
    } else {
      orgBody.className = 'empty';
      orgBody.textContent = 'No organization page connected yet.';
    }
  }

  function loadStatus() {
    return getJson('/api/linkedin/').then(function (r) {
      if (r.ok) { conn = r.body; renderStatus(); }
      else { conn = null; renderStatus(); }
    });
  }

  function setTarget(target) {
    clearMessage();
    getJson('/api/linkedin/publish-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: target })
    }).then(function (r) {
      if (r.ok) {
        showMessage('Publishing as: ' + target + '.', 'success');
        loadStatus();
      } else {
        showMessage(r.body.error || 'Could not switch publish target.', 'error');
      }
    });
  }

  function runDiscovery() {
    clearMessage();
    var btn = $('btn-discover');
    btn.disabled = true;
    btn.textContent = 'Discovering...';
    getJson('/api/linkedin/org/discover', { method: 'POST' }).then(function (r) {
      var box = $('org-candidates');
      box.innerHTML = '';
      if (!r.ok) {
        showMessage(r.body.error || 'Discovery failed.', 'error');
        return;
      }
      if (r.body.stored) {
        showMessage('Exactly one administered organization found and connected.', 'success');
        loadStatus();
        return;
      }
      var cands = r.body.candidates || [];
      if (cands.length === 0) {
        showMessage('No administered organization found for the connected member. Org mode stays unavailable.', 'warn');
        return;
      }
      showMessage('Several administered organizations found. Pick one to connect.', 'warn');
      cands.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'org-candidate';
        var span = document.createElement('span');
        span.textContent = c.orgUrn;
        var pick = document.createElement('button');
        pick.className = 'btn btn-secondary';
        pick.textContent = 'Connect this org';
        pick.addEventListener('click', function () {
          getJson('/api/linkedin/org', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orgUrn: c.orgUrn })
          }).then(function (rr) {
            if (rr.ok) {
              showMessage('Organization connected.', 'success');
              $('org-candidates').innerHTML = '';
              loadStatus();
            } else {
              showMessage(rr.body.error || 'Could not connect that organization.', 'error');
            }
          });
        });
        row.appendChild(span);
        row.appendChild(pick);
        box.appendChild(row);
      });
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Connect Org Page (run discovery)';
    });
  }

  function setTokens() {
    clearMessage();
    var access = $('tok-access').value.trim();
    var refresh = $('tok-refresh').value.trim();
    if (!access || !refresh) {
      showMessage('Both tokens are required; nothing was stored.', 'error');
      return;
    }
    var payload = { accessToken: access, refreshToken: refresh };
    var e1 = parseInt($('tok-expires').value, 10);
    var e2 = parseInt($('tok-refresh-expires').value, 10);
    if (e1 > 0) payload.expiresIn = e1;
    if (e2 > 0) payload.refreshTokenExpiresIn = e2;
    var btn = $('btn-set-tokens');
    btn.disabled = true;
    getJson('/api/linkedin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.ok) {
        showMessage('Token pair stored. ' + (r.body.note || ''), 'success');
        $('tok-access').value = '';
        $('tok-refresh').value = '';
        $('tok-expires').value = '';
        $('tok-refresh-expires').value = '';
        loadStatus();
      } else {
        showMessage(r.body.error || 'Failed to store tokens.', 'error');
      }
    }).then(function () { btn.disabled = false; });
  }

  fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      $('loading').style.display = 'none';
      if (!data.user || data.user.role !== 'owner') {
        $('denied').style.display = '';
        return;
      }
      $('app').style.display = '';
      $('target-personal').addEventListener('click', function () { setTarget('personal'); });
      $('target-organization').addEventListener('click', function () { setTarget('organization'); });
      $('btn-discover').addEventListener('click', runDiscovery);
      $('btn-set-tokens').addEventListener('click', setTokens);
      loadStatus();
    })
    .catch(function () {
      $('loading').style.display = 'none';
      $('denied').style.display = '';
    });
})();
