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

  
  // Fail-open guard: if no API response answers the access check
  // within 5 seconds (network failure, server down), reveal the
  // page; each card then reports its own errors honestly.
  setTimeout(function () {
    if (!window.__omWall) document.body.classList.remove('om-checking');
  }, 5000);

  function getJson(path, opts) {
    var o = opts || {};
    o.credentials = 'include';
    o.headers = o.headers || {};
    o.headers['Accept'] = 'application/json';
    return fetch(API + path, o).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
              if (res.status === 403 && body && body.code === 'ORGANIZATION_MANAGER_DISABLED') {
        if (!window.__omWall) {
          window.__omWall = true;
          var wall = document.getElementById('om-wall');
          if (wall) { wall.hidden = false; wall.className = 'auth-wall shown'; }
        }
      } else if (document.body.classList.contains('om-checking')) {
        // First non-gated response: the access check has answered,
        // reveal the page (mirrors platform-admin's main-content).
        document.body.classList.remove('om-checking');
      }
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
      '<div class="row"><span class="k">Refresh Token on File</span><span class="v">' + pill(conn.hasRefreshToken, 'yes', 'no') + '</span></div>' +
      '<div class="row"><span class="k">Organization page</span><span class="v">' + pill(conn.orgConfigured, 'configured', 'not configured') + '</span></div>' +
      '<div class="row"><span class="k">Person URN</span><span class="v" title="' + esc(conn.personUrn) + '">' + esc(conn.personUrn || 'not stored') + '</span></div>' +
      '<div class="row"><span class="k">Org URN</span><span class="v" title="' + esc(conn.orgUrn) + '">' + esc(conn.orgUrn || 'not stored') + '</span></div>' +
      '<div class="row"><span class="k">Access Token Expiry</span><span class="v">' + esc(whenEpoch(conn.accessTokenExpiresAt)) + '</span></div>' +
      '<div class="row"><span class="k">Refresh Token Expiry</span><span class="v">' + esc(whenEpoch(conn.refreshTokenExpiresAt)) + '</span></div>';

    $('target-personal').className = 'toggle-btn' + (conn.publishTarget === 'personal' ? ' active' : '');
    $('target-organization').className = 'toggle-btn' + (conn.publishTarget === 'organization' ? ' active' : '');
    $('target-organization').disabled = !conn.orgConfigured;
    $('target-organization').title = conn.orgConfigured ? '' : 'Connect an organization page first';
    $('target-current').textContent = conn.publishTarget
      ? 'Current setting: new drafts will publish to the ' + (conn.publishTarget === 'organization' ? 'Organization Page.' : 'Personal profile.')
      : 'Current setting: not chosen yet; new drafts cannot resolve a destination until one is selected.';

    var ac = conn.appConfig || {};
    var acBody = $('appconfig-body');
    acBody.className = '';
    acBody.innerHTML =
      '<div class="row"><span class="k">Workspace client id + secret</span><span class="v">' +
      pill(!!ac.tenantPairConfigured, 'workspace pair set', 'using platform default') + '</span></div>' +
      '<div class="row"><span class="k">Workspace redirect URI</span><span class="v" title="' + esc(ac.tenantRedirectUri) + '">' +
      esc(ac.tenantRedirectUri || 'using platform default') + '</span></div>';

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

  function setAppConfig() {
    clearMessage();
    var clientId = $('app-client-id').value.trim();
    var clientSecret = $('app-client-secret').value.trim();
    var redirectUri = $('app-redirect-uri').value;
    var payload = {};
    if (clientId || clientSecret) {
      if (!clientId || !clientSecret) {
        showMessage('Client id and secret are a pair: supply both, or neither. Nothing was stored.', 'error');
        return;
      }
      payload.clientId = clientId;
      payload.clientSecret = clientSecret;
    }
    // The redirect field always submits: a non-empty value stores the
    // override, an empty value clears it back to the platform default.
    payload.redirectUri = redirectUri;
    if (!payload.clientId && redirectUri.trim() === '') {
      // Nothing to store and nothing to clear was typed; treat an
      // untouched form as a no-op rather than clearing silently.
      var current = (conn && conn.appConfig && conn.appConfig.tenantRedirectUri) || null;
      if (!current) {
        showMessage('Nothing to store: supply the pair, a redirect URI, or both.', 'warn');
        return;
      }
    }
    var btn = $('btn-set-appconfig');
    btn.disabled = true;
    getJson('/api/linkedin/app-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.ok) {
        var bits = [];
        if (r.body.pairStored) bits.push('pair stored (encrypted)');
        if (r.body.redirectStored) bits.push('redirect URI stored');
        if (r.body.redirectCleared) bits.push('redirect override cleared');
        showMessage('App credentials updated: ' + (bits.join(', ') || 'no changes') + '.', 'success');
        $('app-client-id').value = '';
        $('app-client-secret').value = '';
        $('app-redirect-uri').value = '';
        loadStatus();
      } else {
        showMessage(r.body.error || 'Failed to store app credentials.', 'error');
      }
    }).then(function () { btn.disabled = false; });
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
      $('btn-set-appconfig').addEventListener('click', setAppConfig);
      loadStatus();
    })
    .catch(function () {
      $('loading').style.display = 'none';
      $('denied').style.display = '';
    });
})();
