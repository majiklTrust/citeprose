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
      d.textContent = 'Disconnect Profile';
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

  // -- My queue -----------------------------------------------------

  function renderQueue(variants) {
    var el = $('queue-body');
    var pending = (variants || []).filter(function (v) { return v.status === 'pending_approval'; });
    var recent = (variants || []).filter(function (v) { return v.status !== 'pending_approval'; }).slice(0, 5);
    if (pending.length === 0 && recent.length === 0) {
      el.className = 'empty';
      el.textContent = 'No variants yet. When the owner generates from a workspace post, yours appear here.';
      return;
    }
    el.className = '';
    el.innerHTML = '';
    pending.forEach(function (v) {
      var box = document.createElement('div');
      box.style.cssText = 'border:1px solid #e0e0e0;border-radius:6px;padding:0.8rem;margin-bottom:0.8rem';
      var meta = document.createElement('div');
      meta.className = 'hint';
      meta.textContent = 'Variant #' + v.id + (v.source_post_id ? ' from post ' + v.source_post_id : '') + ', ' + when(v.created_at);
      var ta = document.createElement('textarea');
      ta.style.cssText = 'width:100%;min-height:110px;margin:0.5rem 0;padding:0.5rem;border:1px solid #ccc;border-radius:4px;font:inherit;font-size:0.84rem';
      ta.value = v.content;
      var approve = document.createElement('button');
      approve.className = 'btn btn-primary';
      approve.textContent = 'Approve';
      approve.addEventListener('click', function () {
        var payload = ta.value !== v.content ? { content: ta.value } : {};
        getJson('/api/advocacy/me/variants/' + v.id + '/approve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        }).then(function (r) {
          if (r.ok) { showMessage('Approved' + (r.body.note ? ': ' + r.body.note : '') + '.', 'success'); loadQueue(); }
          else showMessage(r.body.error || 'Could not approve.', 'error');
        });
      });
      var reject = document.createElement('button');
      reject.className = 'btn btn-danger';
      reject.style.marginLeft = '0.5rem';
      reject.textContent = 'Reject';
      reject.addEventListener('click', function () {
        getJson('/api/advocacy/me/variants/' + v.id + '/reject', { method: 'POST' }).then(function (r) {
          if (r.ok) { showMessage('Rejected.', 'success'); loadQueue(); }
          else showMessage(r.body.error || 'Could not reject.', 'error');
        });
      });
      box.appendChild(meta); box.appendChild(ta); box.appendChild(approve); box.appendChild(reject);
      el.appendChild(box);
    });
    if (recent.length > 0) {
      var h = document.createElement('div');
      h.className = 'hint';
      h.style.marginTop = '0.6rem';
      h.textContent = 'Recent: ' + recent.map(function (v) { return '#' + v.id + ' ' + v.status; }).join(', ');
      el.appendChild(h);
      recent.filter(function (v) { return v.status === 'published'; }).forEach(function (v) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:0.5rem;padding:0.6rem;border:1px dashed #ccc;border-radius:6px;font-size:0.8rem';
        var lbl = document.createElement('div');
        lbl.className = 'hint';
        lbl.textContent = 'Report performance for #' + v.id + ' (your numbers from LinkedIn, stored as self-reported'
          + (v.reported_at ? '; last saved ' + when(v.reported_at) : '') + ')';
        wrap.appendChild(lbl);
        var inputs = {};
        ['impressions', 'reactions', 'comments'].forEach(function (f) {
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = f;
          inp.value = v['reported_' + f] === null || v['reported_' + f] === undefined ? '' : String(v['reported_' + f]);
          inp.style.cssText = 'width:31%;margin-right:2%;padding:0.35rem;border:1px solid #ccc;border-radius:4px;font-size:0.8rem';
          inputs[f] = inp;
          wrap.appendChild(inp);
        });
        var save = document.createElement('button');
        save.className = 'btn btn-secondary';
        save.style.marginTop = '0.4rem';
        save.textContent = 'Save Report';
        save.addEventListener('click', function () {
          save.disabled = true;
          getJson('/api/advocacy/me/variants/' + v.id + '/report', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              impressions: inputs.impressions.value.trim(),
              reactions: inputs.reactions.value.trim(),
              comments: inputs.comments.value.trim()
            })
          }).then(function (r) {
            save.disabled = false;
            if (r.ok) { showMessage('Performance report saved (self-reported).', 'success'); loadQueue(); }
            else showMessage(r.body.error || 'Could not save the report.', 'error');
          });
        });
        wrap.appendChild(save);
        el.appendChild(wrap);
      });
      recent.filter(function (v) { return v.status === 'approved'; }).forEach(function (v) {
        var pub = document.createElement('button');
        pub.className = 'btn btn-primary';
        pub.style.marginTop = '0.5rem';
        pub.textContent = 'Publish approved variant #' + v.id;
        pub.addEventListener('click', function () {
          pub.disabled = true;
          getJson('/api/advocacy/me/variants/' + v.id + '/publish', { method: 'POST' }).then(function (r) {
            pub.disabled = false;
            if (r.ok) { showMessage('Published to your profile (post ' + (r.body.linkedinId || '') + ').', 'success'); loadQueue(); }
            else showMessage(r.body.error || ('Publish failed' + (r.body.code ? ' (' + r.body.code + ')' : '')), 'error');
          });
        });
        el.appendChild(pub);
      });
    }
  }

  function loadQueue() {
    return getJson('/api/advocacy/me/variants').then(function (r) {
      if (r.ok) renderQueue(r.body.variants);
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

  function loadGenStatus() {
    return getJson('/api/advocacy/variants/status').then(function (r) {
      var el = $('gen-status');
      if (!r.ok || !r.body.counts || r.body.counts.length === 0) {
        el.className = 'empty'; el.textContent = 'No variants generated yet.'; return;
      }
      el.className = '';
      el.textContent = 'Queue totals: ' + r.body.counts.map(function (c) {
        return c.member_sub.slice(0, 18) + ' ' + c.status + ':' + c.n;
      }).join('  |  ');
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
      loadMe().then(function () {
        if (me && me.enabled) {
          $('queue-section').style.display = '';
          loadQueue();
        }
      });
      if (role === 'owner') {
        $('owner-section').style.display = '';
        $('btn-enable').addEventListener('click', function () {
          var sub = $('enable-sub').value.trim();
          if (!sub) { showMessage('Enter the member auth sub to enable.', 'warn'); return; }
          toggleMember(sub, true);
        });
        loadMembers();
        $('generate-section').style.display = '';
        $('btn-generate').addEventListener('click', function () {
          clearMessage();
          var pid = $('gen-post-id').value.trim();
          if (!pid) { showMessage('Enter a source post id.', 'warn'); return; }
          $('btn-generate').disabled = true;
          getJson('/api/advocacy/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: pid })
          }).then(function (r) {
            $('btn-generate').disabled = false;
            if (r.ok) {
              showMessage('Generated ' + r.body.generated + ' variant(s) across ' + r.body.members + ' member(s)' + (r.body.failed ? ', ' + r.body.failed + ' failed a gate' : '') + '.', 'success');
              loadQueue();
              loadGenStatus();
            } else {
              showMessage(r.body.error || 'Generation failed.', 'error');
            }
          });
        });
        $('btn-voice').addEventListener('click', function () {
          clearMessage();
          var sub = $('voice-sub').value.trim();
          if (!sub) { showMessage('Enter the member auth sub for voice notes.', 'warn'); return; }
          getJson('/api/advocacy/members/voice-notes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sub: sub, voiceNotes: $('voice-notes').value })
          }).then(function (r) {
            if (r.ok) { showMessage(r.body.cleared ? 'Voice notes cleared.' : 'Voice notes saved.', 'success'); loadMembers(); }
            else showMessage(r.body.error || 'Could not save voice notes.', 'error');
          });
        });
        loadGenStatus();
      }
    })
    .catch(function () {
      $('loading').style.display = 'none';
      $('denied').style.display = '';
    });
})();
