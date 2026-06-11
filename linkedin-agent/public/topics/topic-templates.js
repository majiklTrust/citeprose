// ═══════════════════════════════════════════════════════════════
// public/topics/topic-templates.js — Research Instructions editor
// ═══════════════════════════════════════════════════════════════
// Per-topic editor for topics.search_templates, presented in user
// language: "Research Instructions — what your AI researcher types
// into the web before writing this topic's posts."
//
// Three UX elements beyond the basic editor:
//   influence panel — Angle, Instructions, and Post as three live
//       boxes. The angle has TWO outgoing arrows (supplies the
//       words → search; sets the voice → post); flipping the angle
//       picker re-renders the queries with provenance highlighting
//       so the combination's influence is demonstrated, not told.
//   placeholder chips — tap to insert at the cursor; plain-word
//       labels; removes the typo class entirely.
//   live queries — every template rendered with color-coded
//       provenance (angle words vs fixed skeleton vs auto fills);
//       empty topics show the derived fallback queries instead.
//
// Server-side validateSearchTemplates remains authoritative; the
// client mirrors limits only for instant feedback.
(function () {
  'use strict';

  // Single source of truth: the chips. The validation whitelist is
  // derived from them, so the two can never drift apart.
  var CHIPS = [
    ['{{ANGLE}}', "this post's angle"],
    ['{{KEYWORDS}}', 'key words from the angle'],
    ['{{YEAR_RANGE}}', 'last year + this year, auto-updates'],
    ['{{TOPIC_NAME}}', "this topic's name"]
  ];
  var PLACEHOLDERS = CHIPS.map(function (c) { return c[0].slice(2, -2); });
  var MAX_TEMPLATES = 5;
  var MAX_LEN = 200;
  var deps = null;   // { API, esc, showMessage, reload }
  var pending = {};  // topicId -> { list, name, desc, angles, angleIdx }

  function keywords(text) {
    return String(text || '').toLowerCase().split(/\s+/)
      .filter(function (w) { return w.length > 3; })
      .slice(0, 5).join(' ');
  }

  function unknownPlaceholder(tpl) {
    var m, re = /\{\{([^}]*)\}\}/g;
    while ((m = re.exec(tpl)) !== null) {
      if (PLACEHOLDERS.indexOf(m[1]) === -1) return m[1] || '(empty)';
    }
    return null;
  }

  function cleanSeg(s) {
    return String(s).replace(/["\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ');
  }

  // Effective angle for the panel: the picked one, or the first as
  // the auto-rotation's representative. 'General discussion' never
  // contributes (mirrors the server).
  function ctxFor(s) {
    var angle = '';
    if (s.angles.length > 0) {
      var idx = (s.angleIdx >= 0 && s.angleIdx < s.angles.length) ? s.angleIdx : 0;
      angle = s.angles[idx];
    }
    if (angle.toLowerCase() === 'general discussion') angle = '';
    return {
      ANGLE: angle,
      KEYWORDS: angle ? keywords(angle) : keywords(s.name + ' ' + s.desc),
      YEAR_RANGE: (new Date().getFullYear() - 1) + ' ' + new Date().getFullYear(),
      TOPIC_NAME: s.name || ''
    };
  }

  // A query rendered as HTML with provenance tints: angle-derived
  // words (ANGLE/KEYWORDS), auto fills (YEAR_RANGE/TOPIC_NAME), and
  // the template's fixed skeleton in neutral.
  function highlightQuery(tpl, ctx) {
    var esc = deps.esc, html = '', last = 0, m, nonEmpty = false;
    var re = /\{\{([^}]*)\}\}/g;
    while ((m = re.exec(tpl)) !== null) {
      var fixed = cleanSeg(tpl.slice(last, m.index));
      if (fixed.trim()) nonEmpty = true;
      html += esc(fixed);
      var v = ctx[m[1]] || '';
      if (v) {
        nonEmpty = true;
        var cls = (m[1] === 'ANGLE' || m[1] === 'KEYWORDS') ? 'tpl-hl-angle' : 'tpl-hl-fill';
        html += '<span class="' + cls + '">' + esc(cleanSeg(v)) + '</span>';
      }
      last = m.index + m[0].length;
    }
    var tail = cleanSeg(tpl.slice(last));
    if (tail.trim()) nonEmpty = true;
    html += esc(tail);
    return nonEmpty ? html : null;
  }

  // Mirrors the server's derived fallback so an empty topic still
  // shows what research will actually run.
  function derivedQueries(s, ctx) {
    var kw = ctx.KEYWORDS, name = ctx.TOPIC_NAME;
    return [
      name + ' ' + kw + ' ' + ctx.YEAR_RANGE,
      kw + ' ' + name + ' case study analysis',
      name + ' ' + kw + ' expert report'
    ].map(function (q) { return cleanSeg(q).trim(); }).filter(Boolean);
  }

  function renderInfluence(s) {
    var esc = deps.esc, ctx = ctxFor(s);
    var html = '<div class="tpl-influence">';
    html += '<div class="tpl-arc"><span>sets the voice</span></div>';
    html += '<div class="tpl-flow">';

    // Box 1 — the angle (picker)
    html += '<div class="tpl-box"><div class="tpl-box-title">The Angle</div><div class="tpl-box-sub">your perspective</div>';
    if (s.angles.length > 0) {
      html += '<select class="tpl-angle-select">';
      html += '<option value="-1">Auto-rotate (' + s.angles.length + ' angles)</option>';
      s.angles.forEach(function (a, i) {
        html += '<option value="' + i + '"' + (i === s.angleIdx ? ' selected' : '') + '>' + esc(a) + '</option>';
      });
      html += '</select>';
    } else {
      html += '<div class="tpl-box-empty">no angles yet</div>';
    }
    html += '</div>';

    html += '<div class="tpl-arrow"><span>supplies the words</span>▶</div>';

    // Box 2 — the instructions (live queries with provenance)
    html += '<div class="tpl-box"><div class="tpl-box-title">Research Instructions</div><div class="tpl-box-sub">the fact hunt</div>';
    if (s.list.length > 0) {
      html += '<ol class="tpl-queries">';
      s.list.forEach(function (tpl) {
        var q = highlightQuery(tpl, ctx);
        html += '<li>' + (q !== null ? q : '<em class="tpl-skip">renders empty — skipped</em>') + '</li>';
      });
      html += '</ol>';
    } else {
      html += '<ol class="tpl-queries">';
      derivedQueries(s, ctx).forEach(function (q) { html += '<li>' + esc(q) + '</li>'; });
      html += '</ol><div class="tpl-box-note">derived from name &amp; description — add instructions to take control</div>';
    }
    html += '</div>';

    html += '<div class="tpl-arrow"><span>supplies the facts</span>▶</div>';

    // Box 3 — the post (live sentence)
    var voice = s.angles.length === 0 ? 'Written as a general overview'
      : (s.angleIdx >= 0 ? 'Written from the lens of \u201C' + esc(ctx.ANGLE) + '\u201D' : 'Written from an auto-rotated angle');
    html += '<div class="tpl-box"><div class="tpl-box-title">Your Post</div><div class="tpl-box-sub">perspective + facts</div>';
    html += '<div class="tpl-box-text">' + voice + ', built on what these searches find \u2014 named events, dates, numbers.</div></div>';

    html += '</div></div>';
    return html;
  }

  function render(id) {
    var s = pending[id], esc = deps.esc;
    if (!s) return '';
    var html = '<div class="tpl-sub">What your AI researcher types into the web before writing this topic\u2019s posts.</div>';
    html += renderInfluence(s);

    s.list.forEach(function (tpl, i) {
      html += '<div style="display:flex;gap:0.4rem;align-items:center;margin-bottom:0.3rem;">';
      html += '<code style="flex:1;font-size:0.8rem;background:#f5f5f5;padding:0.2rem 0.4rem;border-radius:3px;">' + esc(tpl) + '</code>';
      html += '<button class="btn btn-sm btn-secondary btn-tpl-remove" data-idx="' + i + '">Remove</button>';
      html += '</div>';
    });

    if (s.list.length < MAX_TEMPLATES) {
      html += '<div style="display:flex;gap:0.4rem;margin-top:0.4rem;">';
      html += '<input type="text" class="tpl-input" maxlength="' + MAX_LEN + '" placeholder="e.g., recent {{KEYWORDS}} incident report {{YEAR_RANGE}}">';
      html += '<button class="btn btn-sm btn-secondary btn-tpl-add">Add</button>';
      html += '</div>';
      html += '<div style="margin-top:0.35rem;">';
      CHIPS.forEach(function (c) {
        html += '<button class="tpl-chip" data-ph="' + c[0] + '" title="' + c[1] + '">' + c[0] + '</button>';
      });
      html += '<span class="tpl-chip-hint">tap to insert \u2014 fills in automatically at research time (up to ' + MAX_TEMPLATES + ' instructions, ' + MAX_LEN + ' chars each)</span>';
      html += '</div>';
    }
    if (s.suggestions && s.suggestions.length > 0) {
      html += '<div style="margin-top:0.45rem;"><span style="font-size:0.78rem;font-weight:600;color:#555;">Suggested by your AI researcher \u2014 review and add:</span>';
      s.suggestions.forEach(function (tpl, i) {
        html += '<div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.3rem;">';
        html += '<code style="flex:1;font-size:0.8rem;background:#f3e5f5;padding:0.2rem 0.4rem;border-radius:3px;">' + deps.esc(tpl) + '</code>';
        html += '<button class="btn btn-sm btn-secondary btn-tpl-sug-add" data-idx="' + i + '">Add</button>';
        html += '<button class="btn btn-sm btn-secondary btn-tpl-sug-dismiss" data-idx="' + i + '">\u00D7</button>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '<div style="margin-top:0.45rem;display:flex;gap:0.4rem;">';
    html += '<button class="btn btn-sm btn-primary btn-tpl-save">Save Research Instructions</button>';
    if (s.list.length < MAX_TEMPLATES) {
      html += '<button class="btn btn-sm btn-secondary btn-tpl-suggest"' + (s.suggesting ? ' disabled' : '') + '>'
        + (s.suggesting ? 'Asking your AI researcher\u2026' : '\u2728 Suggest instructions') + '</button>';
    }
    html += '</div>';
    return html;
  }

  function save(id) {
    var s = pending[id];
    fetch(deps.API + '/api/topics/' + id, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_templates: s.list })
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to save'); });
        deps.showMessage('Research instructions saved', 'success');
        deps.reload();
      })
      .catch(function (err) { deps.showMessage(err.message, 'error'); });
  }

  function configure(d) { deps = d; }

  function register(t, angles) {
    var tpls = Array.isArray(t.search_templates)
      ? t.search_templates.filter(function (s) { return typeof s === 'string'; })
      : [];
    pending[t.id] = {
      list: tpls.slice(),
      name: t.name || '',
      desc: t.description || '',
      angles: Array.isArray(angles) ? angles.filter(function (a) { return typeof a === 'string' && a.trim(); }) : [],
      angleIdx: -1,      // -1 = auto-rotate
      suggestions: null, // null = none requested; [] = requested, consumed
      suggesting: false
    };
  }

  function bindAll() {
    document.querySelectorAll('.tpl-editor').forEach(function (box) {
      var id = box.dataset.id;
      box.innerHTML = render(id);
      box.addEventListener('change', function (e) {
        if (e.target.classList.contains('tpl-angle-select')) {
          pending[id].angleIdx = parseInt(e.target.value, 10);
          box.innerHTML = render(id);
        }
      });
      box.addEventListener('click', function (e) {
        var s = pending[id];
        if (!s) return;
        if (e.target.classList.contains('btn-tpl-remove')) {
          s.list.splice(parseInt(e.target.dataset.idx, 10), 1);
          box.innerHTML = render(id);
        } else if (e.target.classList.contains('tpl-chip')) {
          var input = box.querySelector('.tpl-input');
          if (!input) return;
          var ph = e.target.dataset.ph;
          var pos = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
          input.value = input.value.slice(0, pos) + ph + input.value.slice(pos);
          input.focus();
          input.selectionStart = input.selectionEnd = pos + ph.length;
        } else if (e.target.classList.contains('btn-tpl-add')) {
          var inp = box.querySelector('.tpl-input');
          var v = (inp && inp.value || '').trim();
          if (!v) return;
          if (v.length > MAX_LEN) { deps.showMessage('Instruction exceeds ' + MAX_LEN + ' characters', 'error'); return; }
          var bad = unknownPlaceholder(v);
          if (bad !== null) { deps.showMessage('Unknown placeholder {{' + bad + '}} \u2014 use the chips below the input', 'error'); return; }
          s.list.push(v);
          box.innerHTML = render(id);
        } else if (e.target.classList.contains('btn-tpl-suggest')) {
          if (s.suggesting) return;
          s.suggesting = true;
          box.innerHTML = render(id);
          fetch(deps.API + '/api/topics/' + id + '/suggest-templates', { method: 'POST', credentials: 'include' })
            .then(function (res) {
              if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
              return res.json();
            })
            .then(function (data) {
              s.suggesting = false;
              s.suggestions = (data.suggestions || []).filter(function (t) { return s.list.indexOf(t) === -1; });
              if (s.suggestions.length === 0) deps.showMessage('No new suggestions \u2014 try again', 'error');
              box.innerHTML = render(id);
            })
            .catch(function (err) {
              s.suggesting = false;
              box.innerHTML = render(id);
              deps.showMessage(err.message, 'error');
            });
        } else if (e.target.classList.contains('btn-tpl-sug-add')) {
          var si = parseInt(e.target.dataset.idx, 10);
          if (s.list.length >= MAX_TEMPLATES) { deps.showMessage('Limit of ' + MAX_TEMPLATES + ' instructions reached', 'error'); return; }
          var sug = s.suggestions[si];
          if (s.list.indexOf(sug) === -1) s.list.push(sug);
          s.suggestions.splice(si, 1);
          box.innerHTML = render(id);
        } else if (e.target.classList.contains('btn-tpl-sug-dismiss')) {
          s.suggestions.splice(parseInt(e.target.dataset.idx, 10), 1);
          box.innerHTML = render(id);
        } else if (e.target.classList.contains('btn-tpl-save')) {
          save(id);
        }
      });
    });
  }

  window.TopicTemplates = { configure: configure, register: register, bindAll: bindAll };
})();
