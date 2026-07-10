// =================================================================
// public/analytics/analytics.js, Analytics page logic (Phase 1)
// =================================================================
// Read discipline mirrors the API (FR-CC-07 / FR-P1-07):
//   - metrics render exactly as returned; null metrics render as a
//     "not yet retrieved" badge, never as zeros
//   - platform-computed panels are labeled computed in the HTML
// Failure surfacing (FR-CC-01/02): sync and narrative failures are
// keyed on the typed code from the API so token expiry, scope
// denial, rate limiting, and not-connected each read differently.
// =================================================================

(function () {
  var API = window.location.origin;
  var role = null;

  function $(id) { return document.getElementById(id); }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str === null || str === undefined ? '' : String(str);
    return div.innerHTML;
  }

  function fmt(n) {
    if (n === null || n === undefined) return '';
    return Number(n).toLocaleString();
  }

  function when(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  // Distinct, human-readable text per failure code (FR-CC-01).
  var CODE_TEXT = {
    LINKEDIN_TOKEN_EXPIRED: 'LinkedIn rejected the stored token (expired or revoked). Reconnect LinkedIn from the dashboard to resume metric sync.',
    LINKEDIN_SCOPE_DENIED: 'LinkedIn denied a required permission (scope). Analytics stays disabled until re-authorization grants it; other features are unaffected.',
    LINKEDIN_RATE_LIMITED: 'LinkedIn rate limited this endpoint. The sync stopped early; try again later.',
    LINKEDIN_ENDPOINT_ERROR: 'LinkedIn returned an unexpected endpoint error. Details are in the activity log.',
    LINKEDIN_NETWORK: 'The LinkedIn call failed at the network layer (timeout or connectivity).',
    LINKEDIN_NOT_CONNECTED: 'LinkedIn is not connected for this workspace. Connect it from the dashboard first.',
    LINKEDIN_ORG_NOT_CONFIGURED: 'LinkedIn is connected, but no organization page is configured. Org analytics needs one: use Connect Org Page in LinkedIn settings.',
    NARRATIVE_NOT_CONFIGURED: 'Narrative synthesis is not configured: the analytics_narrative prompt has not been seeded in the vault.'
  };

  function showMessage(text, type, code) {
    var el = $('message');
    var codeTag = code ? ' <code>' + esc(code) + '</code>' : '';
    el.innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + codeTag + '</div>';
  }

  function clearMessage() { $('message').innerHTML = ''; }

  function failureText(code, fallback) {
    return CODE_TEXT[code] || fallback || 'The request failed.';
  }

  function windowDays() { return parseInt($('window-select').value, 10) || 30; }

  // -- Access check ----------------------------------------------

  function checkAccess() {
    return fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.user || !data.user.role) return null;
        return data.user.role;
      })
      .catch(function () { return null; });
  }

  // -- Posts table (FR-P1-01/02/07) ------------------------------

  function renderPosts(data) {
    var el = $('posts-body');
    if (!data.posts || data.posts.length === 0) {
      el.className = 'empty';
      el.textContent = 'No published posts in this window.';
      return;
    }
    var html = '<table><thead><tr>'
      + '<th>Post</th><th>Topic</th><th class="num">Impressions</th>'
      + '<th class="num">Clicks</th><th class="num">Likes</th>'
      + '<th class="num">Comments</th><th class="num">Shares</th>'
      + '<th>Retrieved</th></tr></thead><tbody>';
    data.posts.forEach(function (p) {
      html += '<tr>';
      html += '<td><div class="post-title" title="' + esc(p.title) + '">' + esc(p.title) + '</div>'
        + '<div class="retrieved-note">' + esc(when(p.postedAt)) + '</div></td>';
      html += '<td>' + (p.topic ? '<span class="badge badge-topic">' + esc(p.topic) + '</span>' : '') + '</td>';
      if (p.metrics === null) {
        html += '<td colspan="5"><span class="badge badge-pending">not yet retrieved</span></td>';
        html += '<td class="retrieved-note">pending</td>';
      } else {
        var m = p.metrics;
        html += '<td class="num">' + esc(fmt(m.impressions)) + '</td>';
        html += '<td class="num">' + esc(fmt(m.clicks)) + '</td>';
        html += '<td class="num">' + esc(fmt(m.likes)) + '</td>';
        html += '<td class="num">' + esc(fmt(m.comments)) + '</td>';
        html += '<td class="num">' + esc(fmt(m.shares)) + '</td>';
        html += '<td class="retrieved-note">' + esc(when(p.retrievedAt)) + '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    el.className = '';
    el.innerHTML = html;
  }

  // -- Topics table (FR-P1-04) -----------------------------------

  function renderTopics(data) {
    var el = $('topics-body');
    if (!data.topics || data.topics.length === 0) {
      el.className = 'empty';
      el.textContent = 'No measured posts yet. Run a sync to retrieve metrics.';
      return;
    }
    var html = '<table><thead><tr>'
      + '<th>Topic</th><th class="num">Measured posts</th><th class="num">Impressions</th>'
      + '<th class="num">Clicks</th><th class="num">Interactions</th><th>Latest retrieval</th>'
      + '</tr></thead><tbody>';
    data.topics.forEach(function (t) {
      html += '<tr>'
        + '<td>' + esc(t.topic) + '</td>'
        + '<td class="num">' + esc(fmt(t.measured_posts)) + '</td>'
        + '<td class="num">' + esc(fmt(t.impressions)) + '</td>'
        + '<td class="num">' + esc(fmt(t.clicks)) + '</td>'
        + '<td class="num">' + esc(fmt(t.interactions)) + '</td>'
        + '<td class="retrieved-note">' + esc(when(t.latest_retrieved_at)) + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    el.className = '';
    el.innerHTML = html;
  }

  // -- Heatmap (FR-P1-05) ----------------------------------------

  var DOW_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function heatColor(value, max) {
    if (value === null || max <= 0) return '#f0f0f0';
    var ratio = Math.max(0, Math.min(1, value / max));
    var alpha = 0.12 + 0.88 * ratio;
    return 'rgba(0, 115, 177, ' + alpha.toFixed(2) + ')';
  }

  function renderHeatmap(data) {
    var el = $('heatmap-body');
    if (!data.cells || data.cells.length === 0) {
      el.className = 'empty';
      el.textContent = 'Not enough measured posts to compute a heatmap yet.';
      return;
    }
    var grid = {};
    var max = 0;
    data.cells.forEach(function (c) {
      var v = c.avg_impressions === null ? null : Number(c.avg_impressions);
      grid[c.dow + ':' + c.hour] = { avg: v, posts: c.posts };
      if (v !== null && v > max) max = v;
    });
    var html = '<div class="heatmap">';
    html += '<div class="hm-label"></div>';
    for (var h = 0; h < 24; h++) html += '<div class="hm-hour">' + h + '</div>';
    for (var d = 1; d <= 7; d++) {
      html += '<div class="hm-label">' + DOW_LABELS[d] + '</div>';
      for (var hh = 0; hh < 24; hh++) {
        var cell = grid[d + ':' + hh];
        var title = cell
          ? DOW_LABELS[d] + ' ' + hh + ':00, avg ' + fmt(cell.avg) + ' impressions over ' + fmt(cell.posts) + ' post(s)'
          : DOW_LABELS[d] + ' ' + hh + ':00, no measured posts';
        var color = cell ? heatColor(cell.avg, max) : '#f0f0f0';
        html += '<div class="hm-cell" style="background:' + color + '" title="' + esc(title) + '"></div>';
      }
    }
    html += '</div>';
    el.className = '';
    el.innerHTML = html;
  }

  // -- Demographics (FR-P1-03) -----------------------------------

  function renderDemographics(data) {
    var el = $('demographics-body');
    if (!data.facets || data.facets.length === 0) {
      el.className = 'empty';
      el.textContent = 'No demographics retrieved yet. Run a sync to fetch them.';
      return;
    }
    var byFacet = { industry: [], seniority: [], geo: [] };
    data.facets.forEach(function (row) {
      if (byFacet[row.facet]) byFacet[row.facet].push(row);
    });
    var html = '<div class="demo-grid">';
    ['industry', 'seniority', 'geo'].forEach(function (facet) {
      var rows = byFacet[facet];
      html += '<div class="demo-col"><h3>' + esc(facet) + '</h3>';
      if (rows.length === 0) {
        html += '<div class="empty">none retrieved</div>';
      } else {
        rows.slice(0, 10).forEach(function (r) {
          var name = r.label || r.entity;
          html += '<div class="demo-row"><span class="demo-entity" title="' + esc(r.entity) + '">'
            + esc(name) + '</span><span class="demo-count">' + esc(fmt(r.follower_count)) + '</span></div>';
        });
      }
      html += '</div>';
    });
    html += '</div>';
    el.className = '';
    el.innerHTML = html;
  }

  // -- Loaders ---------------------------------------------------

  function renderAdvocacyIntel(d) {
    var el = document.getElementById('advocacy-intel-body');
    if (!d || !d.funnel) {
      el.className = 'empty';
      el.textContent = 'Advocacy insights unavailable.';
      return;
    }
    var t = d.funnel.totals;
    var html = '<table><thead><tr><th>Measure</th><th>Value</th></tr></thead><tbody>'
      + '<tr><td>Variant Funnel</td><td>' + t.generated + ' generated, ' + (t.approved + t.published) + ' approved, '
      + t.published + ' published' + (d.funnel.publishRate === null ? '' : ' (' + d.funnel.publishRate + '% publish rate)') + '</td></tr>'
      + '<tr><td>In Queue / Rejected / Failed</td><td>' + t.pending + ' pending, ' + t.rejected + ' rejected, ' + t.failed + ' failed a gate'
      + (d.funnel.gateFailures.length ? ' (' + d.funnel.gateFailures.map(function (g) { return g.gate + ': ' + g.n; }).join(', ') + ')' : '') + '</td></tr>'
      + '<tr><td>Activated Reach</td><td>' + Number(d.activatedReach).toLocaleString() + ' connections across ' + d.publishedWithReach + ' published post(s)'
      + (d.publishedUnknownReach > 0 ? ' (+' + d.publishedUnknownReach + ' with unknown reach)' : '') + '</td></tr>'
      + '<tr><td>Member Reported <span class="badge badge-pending">self-reported</span></td><td>'
      + (d.reported.variants === 0 ? 'none reported yet'
        : Number(d.reported.impressions).toLocaleString() + ' impressions, ' + d.reported.reactions + ' reactions, '
          + d.reported.comments + ' comments across ' + d.reported.variants + ' post(s), latest ' + when(d.reported.latestAt)) + '</td></tr>'
      + '</tbody></table>';
    if (d.funnel.members.length > 0) {
      html += '<div class="section-note" style="margin-top:0.7rem">'
        + d.funnel.members.map(function (m) {
            return esc(m.sub.slice(0, 22) + ': ' + m.published + '/' + m.generated + ' published'
              + (m.editRate === null ? '' : ', edits ' + m.editRate + '%')
              + (m.avgDecisionHours === null ? '' : ', avg decision ' + m.avgDecisionHours + 'h'));
          }).join('<br>')
        + '</div>';
    }
    if (d.uptake.length > 0) {
      html += '<div class="section-note">'
        + 'Uptake by source post: ' + d.uptake.slice(0, 8).map(function (u) {
            return 'post ' + u.sourcePostId + ': ' + u.published + '/' + u.generated;
          }).join('  |  ')
        + '</div>';
    }
    el.className = '';
    el.innerHTML = html;
  }

  function renderAmplification(reach) {
    var el = document.getElementById('amplification-body');
    if (!reach) {
      el.className = 'empty';
      el.textContent = 'Advocacy reach unavailable.';
      return;
    }
    var org = reach.orgFollowers || {};
    var orgLine = org.count === null || org.count === undefined
      ? 'not yet retrieved'
      : Number(org.count).toLocaleString() + (org.retrievedAt ? ' (retrieved ' + when(org.retrievedAt) + ')' : '');
    var html = '<table><thead><tr><th>Measure</th><th>Value</th></tr></thead><tbody>'
      + '<tr><td>Organization Followers</td><td>' + esc(orgLine) + '</td></tr>'
      + '<tr><td>Total Member Reach (' + reach.knownCount + ' member' + (reach.knownCount === 1 ? '' : 's') + ')</td><td>'
      + Number(reach.totalKnownReach).toLocaleString()
      + (reach.unknownCount > 0 ? ' (+' + reach.unknownCount + ' member(s) not yet retrieved)' : '') + '</td></tr>'
      + '<tr><td>Amplification Ratio</td><td>' + (reach.amplification === null ? 'not computable yet' : reach.amplification + 'x') + '</td></tr>'
      + '<tr><td>Posts Amplified</td><td>' + reach.postsAmplified + ' (' + reach.variantsPublished + ' member post(s) published)</td></tr>'
      + '</tbody></table>';
    if (reach.members && reach.members.length > 0) {
      html += '<div class="section-note" style="margin-top:0.7rem">'
        + reach.members.map(function (m) {
            return esc((m.name || m.sub.slice(0, 18)) + ': '
              + (m.connectionsSize === null ? 'not retrieved' : Number(m.connectionsSize).toLocaleString() + ' connections')
              + (m.retrievedAt ? ' (' + when(m.retrievedAt) + ')' : ''));
          }).join('<br>')
        + '</div>';
    }
    el.className = '';
    el.innerHTML = html;
  }

  function getJson(path) {
    return fetch(API + path, { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      });
  }

  function loadAll() {
    clearMessage();
    var days = windowDays();
    getJson('/api/analytics/posts?days=' + days).then(function (r) {
      if (r.ok) renderPosts(r.body);
      else { $('posts-body').className = 'empty'; $('posts-body').textContent = 'Failed to load posts.'; }
    });
    getJson('/api/analytics/topics?days=' + days).then(function (r) {
      if (r.ok) renderTopics(r.body);
      else { $('topics-body').className = 'empty'; $('topics-body').textContent = 'Failed to load topics.'; }
    });
    getJson('/api/analytics/heatmap?days=' + days).then(function (r) {
      if (r.ok) renderHeatmap(r.body);
      else { $('heatmap-body').className = 'empty'; $('heatmap-body').textContent = 'Failed to load heatmap.'; }
    });
    getJson('/api/advocacy/reach').then(function (r) {
      renderAmplification(r.ok ? r.body : null);
    });

    getJson('/api/advocacy/insights').then(function (r) {
      renderAdvocacyIntel(r.ok ? r.body : null);
    });

    getJson('/api/analytics/demographics').then(function (r) {
      if (r.ok) renderDemographics(r.body);
      else { $('demographics-body').className = 'empty'; $('demographics-body').textContent = 'Failed to load demographics.'; }
    });
  }

  // -- Actions (owner/editor only) -------------------------------

  function runSync() {
    var btn = $('btn-sync');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    fetch(API + '/api/analytics/sync', {
      method: 'POST', credentials: 'include', headers: { 'Accept': 'application/json' }
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        if (r.ok) {
          var s = r.body.summary || {};
          showMessage('Sync complete: ' + (s.postsUpdated || 0) + ' post(s) updated, '
            + (s.postsFailed || 0) + ' failed, ' + (s.demographicsFacets || 0) + ' demographic facet(s) refreshed.', 'success');
          loadAll();
        } else {
          var code = r.body.code;
          showMessage(failureText(code, r.body.error), code === 'LINKEDIN_RATE_LIMITED' ? 'warn' : 'error', code);
        }
      })
      .catch(function () { showMessage('Sync request failed to reach the server.', 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Sync Now'; });
  }

  function runNarrative() {
    var btn = $('btn-narrative');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    fetch(API + '/api/analytics/narrative', {
      method: 'POST', credentials: 'include',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: windowDays() })
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b }; }); })
      .then(function (r) {
        var section = $('narrative-section');
        var body = $('narrative-body');
        if (r.ok) {
          section.style.display = '';
          body.innerHTML = '<div class="narrative-box">' + esc(r.body.narrative) + '</div>'
            + '<div class="narrative-meta">Window: ' + esc(r.body.windowDays) + ' days. '
            + 'Data points cited: ' + esc((r.body.dataPoints || []).length) + '. '
            + 'Generated by ' + esc(r.body.provider) + '/' + esc(r.body.model) + '.</div>';
        } else if (r.body.blocked) {
          section.style.display = '';
          body.innerHTML = '<div class="msg msg-warn">Narrative blocked: ' + esc(r.body.reason)
            + ' Nothing uncited is ever rendered.</div>';
        } else {
          var code = r.body.code;
          showMessage(failureText(code, r.body.error), 'error', code);
        }
      })
      .catch(function () { showMessage('Narrative request failed to reach the server.', 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Narrative summary'; });
  }

  // -- Init ------------------------------------------------------

  checkAccess().then(function (r) {
    $('loading').style.display = 'none';
    if (!r) {
      $('denied').style.display = '';
      return;
    }
    role = r;
    $('app').style.display = '';
    if (role === 'owner' || role === 'editor') {
      $('btn-sync').style.display = '';
      $('btn-narrative').style.display = '';
      $('btn-sync').addEventListener('click', runSync);
      $('btn-narrative').addEventListener('click', runNarrative);
    }
    $('btn-refresh').addEventListener('click', loadAll);
    $('window-select').addEventListener('change', loadAll);
    loadAll();
  });
})();
