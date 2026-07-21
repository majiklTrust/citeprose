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

  function loadEligiblePosts() {
    var sel = $('gen-post-id');
    getJson('/api/advocacy/eligible-posts').then(function (r) {
      sel.innerHTML = '';
      if (!r.ok || !r.body.posts || r.body.posts.length === 0) {
        var opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No published organization posts yet';
        sel.appendChild(opt);
        $('btn-generate').disabled = true;
        return;
      }
      r.body.posts.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = String(p.id);
        opt.textContent = '#' + p.id + '  ' + (p.title || '(untitled)')
          + (p.posted_at ? '  (' + when(p.posted_at) + ')' : '');
        sel.appendChild(opt);
      });
      $('btn-generate').disabled = false;
    });
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
              if (body && ((res.status === 403 && body.code === 'ORGANIZATION_MANAGER_DISABLED') || (res.status === 402 && body.code === 'ENTITLEMENT_REQUIRED'))) {
        if (!window.__omWall) {
          window.__omWall = true;
          var wall = document.getElementById('om-wall');
          // AUDIT F5 (2.4.2): an entitlement denial reading
          // "disabled by the operator" sends the user hunting for
          // a setting that does not exist. Name the real gate.
          if (wall && res.status === 402) {
            var note = wall.querySelector('p');
            if (note) note.textContent = 'This feature is part of the Business plan and above. The workspace owner can review plans on the Billing page.';
          }
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
      b.textContent = p.consent_granted_at ? 'Reconnect Personal LinkedIn' : 'Review consent and connect';
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
      box.className = 'variant-card';
      var meta = document.createElement('div');
      meta.className = 'hint';
      meta.textContent = 'Variant #' + v.id
        + (v.source_post_title ? ' from "' + v.source_post_title + '"'
           : (v.source_post_id ? ' from post ' + v.source_post_id : ''))
        + ', ' + when(v.created_at);
      var ta = document.createElement('textarea');
      ta.className = 'variant-edit';
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
      recent.filter(function (v) { return v.status === 'published'; }).forEach(function (v) {
        var wrap = document.createElement('div');
        wrap.className = 'report-box';
        var lbl = document.createElement('div');
        lbl.className = 'report-title';
        var lead = document.createElement('span');
        lead.className = 'report-title-lead';
        lead.textContent = 'Report performance on Variant #' + v.id + ':';
        lbl.appendChild(lead);
        lbl.appendChild(document.createTextNode(
          (v.source_post_title ? ' "' + v.source_post_title + '"' : '')
          + ' (your numbers from LinkedIn, stored as self-reported'
          + (v.reported_at ? '; last saved ' + when(v.reported_at) : '') + ')'));
        wrap.appendChild(lbl);
        var inputs = {};
        var grid = document.createElement('table');
        grid.className = 'report-grid';
        var head = grid.createTHead().insertRow();
        var row = grid.createTBody().insertRow();
        ['impressions', 'reactions', 'comments'].forEach(function (f) {
          var th = document.createElement('th');
          th.textContent = f.charAt(0).toUpperCase() + f.slice(1);
          head.appendChild(th);
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.value = v['reported_' + f] === null || v['reported_' + f] === undefined ? '' : String(v['reported_' + f]);
          inp.className = 'report-input';
          inputs[f] = inp;
          row.insertCell().appendChild(inp);
        });
        wrap.appendChild(grid);
        var save = document.createElement('button');
        save.className = 'btn btn-secondary report-save';
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
        pub.className = pub.className + ' variant-publish';
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
    var html = '<table><thead><tr><th>Member</th><th>Connected</th><th>Mode</th><th>Consent</th><th>Connections</th><th>Voice note</th><th></th></tr></thead><tbody>';
    members.forEach(function (m) {
      html += '<tr>'
        + '<td title="' + esc(m.auth_sub) + '">' + esc(m.member_name || m.auth_sub) + '</td>'
        + '<td>' + pill(m.connected, 'yes', 'no') + '</td>'
        + '<td>' + esc(m.mode) + '</td>'
        + '<td>' + esc(m.consent_granted_at ? when(m.consent_granted_at) : 'none') + '</td>'
        + '<td>' + esc(m.connections_size === null ? '' : Number(m.connections_size).toLocaleString()) + '</td>'
        + '<td>' + esc(m.voice_notes ? 'saved ' + when(m.voice_notes_updated_at) : 'none') + '</td>'
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

  function populateVoiceSelect(members) {
    var sel = $('voice-sub');
    if (!sel || sel.tagName !== 'SELECT') return;
    var prev = sel.value;
    sel.innerHTML = '';
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = members.length ? 'Select a member' : 'No members enabled yet';
    sel.appendChild(blank);
    members.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.auth_sub;
      opt.textContent = (m.member_name || m.auth_sub)
        + (m.voice_notes ? ' (note saved ' + when(m.voice_notes_updated_at) + ')' : ' (no note)');
      opt.setAttribute('data-notes', m.voice_notes || '');
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
    sel.onchange = function () {
      var o = sel.options[sel.selectedIndex];
      $('voice-notes').value = o ? (o.getAttribute('data-notes') || '') : '';
    };
  }

  function loadEligibleMembers() {
    var sel = $('enable-sub');
    if (!sel || sel.tagName !== 'SELECT') return;
    getJson('/api/advocacy/eligible-members').then(function (r) {
      sel.innerHTML = '';
      var list = (r.ok && r.body.members) ? r.body.members : [];
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = list.length ? 'Select a member to enroll' : 'All workspace members are enrolled';
      sel.appendChild(blank);
      list.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.auth_sub;
        opt.textContent = m.auth_sub + ' (' + m.role + ')';
        sel.appendChild(opt);
      });
      $('btn-enable').disabled = list.length === 0;
    });
  }

  function loadMembers() {
    return getJson('/api/advocacy/members').then(function (r) {
      if (r.ok) { renderMembers(r.body.members); populateVoiceSelect(r.body.members || []); loadEligibleMembers(); }
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
      var perms = data.permissions || [];
      $('app').style.display = '';
      $('mode-manual').addEventListener('click', function () { setMode('manual'); });
      $('mode-auto').addEventListener('click', function () { setMode('auto'); });
      loadMe().then(function () {
        if (me && me.enabled) {
          $('queue-section').style.display = '';
          loadQueue();
        }
      });
      if (perms.indexOf('manage_advocacy') !== -1) {
        $('owner-section').style.display = '';
        $('btn-enable').addEventListener('click', function () {
          var sub = $('enable-sub').value.trim();
          if (!sub) { showMessage('Select a member to enroll.', 'warn'); return; }
          toggleMember(sub, true);
        });
        loadMembers();
        $('generate-section').style.display = '';
        loadEligiblePosts();
        $('btn-generate').addEventListener('click', function () {
          clearMessage();
          var pid = $('gen-post-id').value.trim();
          if (!pid) { showMessage('Select a source post.', 'warn'); return; }
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
          if (!sub) { showMessage('Select a member for voice notes.', 'warn'); return; }
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
