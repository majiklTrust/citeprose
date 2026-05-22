// ═══════════════════════════════════════════════════════════════
// public/topics/topics.js — Topic management page logic
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;
  var isOwner = false;
  var userSub = null;
  var generatedSystemContext = '';
  var feedSummary = { catchall: 0, topics: [] };
  var _fmVersion = 1;

  function $(id) { return document.getElementById(id); }

  function showMessage(text, type) {
    var el = $('message');
    el.innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + '</div>';
    setTimeout(function () { el.innerHTML = ''; }, 5000);
  }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Access check ───────────────────────────────────────────

  function checkAccess() {
    return fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var user = data.user;
        if (!user) return false;
        // Only owner and editor have manage_own_topics
        if (user.role !== 'owner' && user.role !== 'editor') return false;
        isOwner = user.role === 'owner';
        userSub = user.sub;
        return true;
      })
      .catch(function () { return false; });
  }

  // ── Render topics ──────────────────────────────────────────

  function renderTopicCard(t, canModify) {
    var scopeClass = t.user_sub ? 'scope-personal' : 'scope-global';
    var scopeLabel = t.user_sub ? 'Personal' : 'Global';
    var disabledClass = t.enabled ? '' : ' disabled';
    var angles = t.content_angles || [];
    var hashtags = t.hashtags || [];

    var html = '<div class="topic-card' + disabledClass + '" data-topic-id="' + t.id + '">';
    html += '<div class="topic-header">';
    html += '<div>';
    html += '<span class="topic-name">' + esc(t.name) + '</span> ';
    html += '<span class="scope-badge ' + scopeClass + '">' + scopeLabel + '</span> ';
    html += '<span class="weight-badge">weight: ' + t.weight + '</span> ';
    if (!t.enabled) html += '<span class="weight-badge" style="background:#ffebee;color:#c62828;">disabled</span>';
    html += '</div>';
    html += '<button class="toggle-btn" data-id="' + t.id + '">Details</button>';
    html += '</div>';
    html += '<div class="topic-meta">' + esc(t.slug) + '</div>';

    // Feed count summary
    var topicFeeds = feedSummary.topics.find(function (fs) { return fs.slug === t.slug; });
    var topicFeedCount = topicFeeds ? topicFeeds.feedCount : 0;
    html += '<div class="topic-meta" style="margin-top:0.25rem;">';
    html += topicFeedCount + ' topic feed' + (topicFeedCount !== 1 ? 's' : '');
    html += ' · ' + feedSummary.catchall + ' catchall feed' + (feedSummary.catchall !== 1 ? 's' : '');
    html += ' · <a href="/app/feeds/?topic=' + encodeURIComponent(t.slug) + '" style="color:#0073b1;">Manage Feeds →</a>';
    html += '</div>';

    // Domain tags — always visible on card (v2 only)
    if (_fmVersion === 2) {
      var domains = t.domains || [];
      html += '<div style="margin-top:0.35rem;">';
      html += '<strong style="font-size:0.78rem; color:#666;">Domain Tags:</strong> ';
      if (domains.length > 0) {
        domains.forEach(function (d) { html += '<span class="domain-tag">' + esc(d) + '</span> '; });
      } else {
        html += '<span style="font-size:0.78rem; color:#999; font-style:italic;">none</span>';
      }
      html += '</div>';
    }

    html += '<div class="topic-details" id="details-' + t.id + '">';
    if (t.description) {
      html += '<p style="margin-bottom:0.5rem; font-size:0.88rem; color:#555;">' + esc(t.description) + '</p>';
    }
    if (angles.length > 0) {
      html += '<div style="margin-bottom:0.5rem;"><strong style="font-size:0.85rem;">Content Angles:</strong>';
      html += '<ol class="angle-list">';
      angles.forEach(function (a) { html += '<li>' + esc(a) + '</li>'; });
      html += '</ol></div>';
    }
    if (hashtags.length > 0) {
      html += '<div style="margin-bottom:0.5rem;">';
      hashtags.forEach(function (h) { html += '<span class="tag">' + esc(h) + '</span> '; });
      html += '</div>';
    }
    if (canModify) {
      html += '<div style="margin-top:0.75rem; display:flex; gap:0.4rem;">';
      html += '<button class="btn btn-sm btn-secondary btn-toggle-enabled" data-id="' + t.id + '" data-enabled="' + t.enabled + '">';
      html += t.enabled ? 'Disable' : 'Enable';
      html += '</button>';
      html += '<button class="btn btn-sm btn-danger btn-delete-topic" data-id="' + t.id + '">Delete</button>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function loadTopics() {
    // Fetch feed summary first, then topics
    fetch(API + '/api/feeds/summary', { credentials: 'include' })
      .then(function (res) { return res.ok ? res.json() : { catchall: 0, topics: [] }; })
      .then(function (summary) {
        feedSummary = summary;
        return fetch(API + '/api/topics', { credentials: 'include' });
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        _fmVersion = data.feedsManagerVersion || 1;
        // Update page header with styled version indicator
        var titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.innerHTML = 'Topics Manager <span class="version-badge">(v' + _fmVersion + ')</span><p class="subtitle">research topics for content generation</p>';
        // Show/hide the domain tags form field based on version
        var domainRow = document.getElementById('domain-tags-row');
        if (domainRow) domainRow.style.display = _fmVersion === 2 ? '' : 'none';

        var topics = data.topics || [];
        var globalTopics = topics.filter(function (t) { return !t.user_sub; });
        var personalTopics = topics.filter(function (t) { return t.user_sub === userSub; });
        var otherPersonal = topics.filter(function (t) { return t.user_sub && t.user_sub !== userSub; });

        // Global topics
        if (globalTopics.length === 0) {
          $('global-topics').innerHTML = '<span class="empty">No global topics</span>';
        } else {
          var html = '';
          globalTopics.forEach(function (t) { html += renderTopicCard(t, isOwner); });
          $('global-topics').innerHTML = html;
        }

        // Personal topics
        var myTopics = personalTopics;
        if (isOwner) myTopics = myTopics.concat(otherPersonal);
        if (myTopics.length === 0) {
          $('personal-topics').innerHTML = '<span class="empty">No personal topics</span>';
        } else {
          var html2 = '';
          myTopics.forEach(function (t) {
            var canModify = isOwner || t.user_sub === userSub;
            html2 += renderTopicCard(t, canModify);
          });
          $('personal-topics').innerHTML = html2;
        }

        bindCardEvents();
      })
      .catch(function () {
        $('global-topics').innerHTML = '<span class="msg msg-error">Failed to load topics</span>';
        $('personal-topics').innerHTML = '';
      });
  }

  function bindCardEvents() {
    // Toggle details
    document.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var details = $('details-' + btn.dataset.id);
        if (details) details.classList.toggle('open');
      });
    });
    // Toggle enabled/disabled
    document.querySelectorAll('.btn-toggle-enabled').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var newState = btn.dataset.enabled === 'true' ? false : true;
        toggleTopicEnabled(btn.dataset.id, newState);
      });
    });
    // Delete
    document.querySelectorAll('.btn-delete-topic').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (confirm('Delete this topic? This cannot be undone.')) {
          deleteTopicById(btn.dataset.id);
        }
      });
    });
  }

  // ── CRUD operations ────────────────────────────────────────

  function toggleTopicEnabled(id, enabled) {
    fetch(API + '/api/topics/' + id + '/toggle', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Failed');
        showMessage('Topic ' + (enabled ? 'enabled' : 'disabled'), 'success');
        loadTopics();
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  function deleteTopicById(id) {
    fetch(API + '/api/topics/' + id, {
      method: 'DELETE', credentials: 'include'
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
        showMessage('Topic deleted', 'success');
        loadTopics();
      })
      .catch(function (err) { showMessage(err.message, 'error'); });
  }

  // ── Create topic flow ──────────────────────────────────────

  function resetCreateForm() {
    $('topic-name').value = '';
    $('topic-desc').value = '';
    $('topic-angles').value = '';
    $('topic-hashtags').value = '';
    $('topic-weight').value = '1';
    $('topic-scope').value = 'global';
    if ($('topic-domains')) $('topic-domains').value = '';
    $('generate-result').style.display = 'none';
    generatedSystemContext = '';
  }

  function generateSuggestions() {
    var name = $('topic-name').value.trim();
    var desc = $('topic-desc').value.trim();
    if (!name) { showMessage('Topic name is required', 'error'); return; }
    if (!desc) { showMessage('Description is required', 'error'); return; }

    $('generate-btn').disabled = true;
    $('generate-btn').textContent = 'Generating...';

    fetch(API + '/api/topics/generate', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, description: desc })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Generation failed'); });
        return res.json();
      })
      .then(function (data) {
        $('topic-angles').value = (data.content_angles || []).join('\n');
        $('topic-hashtags').value = (data.hashtags || []).join(', ');
        generatedSystemContext = data._system_context || '';
        $('generate-result').style.display = 'block';
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () {
        $('generate-btn').disabled = false;
        $('generate-btn').textContent = 'Generate Suggestions';
      });
  }

  function saveTopic() {
    var name = $('topic-name').value.trim();
    var desc = $('topic-desc').value.trim();
    var anglesText = $('topic-angles').value.trim();
    var hashtagsText = $('topic-hashtags').value.trim();
    var domainsText = (_fmVersion === 2 && $('topic-domains')) ? $('topic-domains').value.trim() : '';
    var weight = parseInt($('topic-weight').value) || 1;
    var scope = $('topic-scope').value;

    if (!name) { showMessage('Topic name is required', 'error'); return; }

    var angles = anglesText ? anglesText.split('\n').map(function (a) { return a.trim(); }).filter(Boolean) : [];
    var hashtags = hashtagsText ? hashtagsText.split(',').map(function (h) { return h.trim(); }).filter(Boolean) : [];
    var domains = domainsText ? domainsText.split(',').map(function (d) { return d.trim().toLowerCase(); }).filter(Boolean) : [];

    $('save-topic-btn').disabled = true;

    fetch(API + '/api/topics', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        description: desc,
        content_angles: angles,
        hashtags: hashtags,
        domains: domains,
        system_context: generatedSystemContext,
        weight: weight,
        scope: scope
      })
    })
      .then(function (res) {
        if (res.status === 409) throw new Error('A topic with this name already exists');
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
        showMessage('Topic created', 'success');
        resetCreateForm();
        $('create-form').classList.remove('open');
        loadTopics();
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () { $('save-topic-btn').disabled = false; });
  }

  // ── Init ───────────────────────────────────────────────────

  checkAccess().then(function (allowed) {
    $('loading').style.display = 'none';
    if (!allowed) {
      $('denied').style.display = 'block';
      setTimeout(function () { window.location.href = '/app'; }, 3000);
      return;
    }
    $('topics-app').style.display = 'block';

    // Show scope selector for owners only
    if (isOwner) $('scope-row').style.display = 'block';

    loadTopics();

    $('toggle-create-btn').addEventListener('click', function () {
      $('create-form').classList.toggle('open');
    });
    $('generate-btn').addEventListener('click', generateSuggestions);
    $('save-topic-btn').addEventListener('click', saveTopic);
    $('cancel-create-btn').addEventListener('click', function () {
      resetCreateForm();
      $('create-form').classList.remove('open');
    });

    // Generate Suggestions button: grey when form incomplete, green when ready
    function updateGenerateBtn() {
      var name = $('topic-name').value.trim();
      var desc = $('topic-desc').value.trim();
      var btn = $('generate-btn');
      if (name && desc) {
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-ready');
      } else {
        btn.classList.remove('btn-ready');
        btn.classList.add('btn-secondary');
      }
    }
    $('topic-name').addEventListener('input', updateGenerateBtn);
    $('topic-desc').addEventListener('input', updateGenerateBtn);
  });
})();
