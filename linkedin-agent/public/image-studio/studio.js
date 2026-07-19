// =================================================================
// public/image-studio/studio.js - Image Studio standalone page
// =================================================================
// Hand-maintained source (the page html is built from
// public_templates/image-studio-index.html; this file is served
// as-is). Vanilla IIFE following the admin.js conventions: same $,
// message, fetch-with-credentials patterns; every mutating action is
// busy-guarded so it cannot double-fire; server error codes map to
// plain human messages.
//
// Access model: the page probes GET /api/image-studio/budget. A 200
// opens the app; 401/403 shows the signed-out denial; a 402 with
// ENTITLEMENT_REQUIRED shows the honest plan wall instead of a broken
// page. All generation and refinement stays behind the server gates;
// nothing here grants anything.
// =================================================================

(function () {
  var API = ''; // same-origin

  function $(id) { return document.getElementById(id); }

  function showMessage(text, type) {
    var el = $('message');
    el.innerHTML = '<span class="msg msg-' + (type === 'error' ? 'error' : 'success') + '"></span>';
    el.firstChild.textContent = text;
    setTimeout(function () { if (el.firstChild) el.innerHTML = ''; }, 6000);
  }

  function messageFor(status, data) {
    var code = data && data.code;
    if (code === 'ENTITLEMENT_REQUIRED') return 'The Image Studio requires the Business Premium plan.';
    if (code === 'BUDGET_NOT_SET') return 'Set an image budget in Admin before generating.';
    if (code === 'BUDGET_EXCEEDED') return 'The image budget for this cycle is used up. Increase it in Admin.';
    if (code === 'NOT_PROVISIONED') return 'No image provider is configured for this workspace.';
    if (code === 'MISSING_CREDENTIAL') return 'No image API key is configured for this workspace.';
    if (code === 'CONTENT_REJECTED') return (data && data.error) || 'The request was rejected by the content checks.';
    return (data && data.error) || ('Request failed (' + status + ').');
  }

  var selectedId = null;
  var busy = false;

  function setBusy(on) {
    busy = on;
    $('st-generate-btn').disabled = on;
    $('st-refine-btn').disabled = on;
    $('st-generate-btn').textContent = on ? 'Working...' : 'Generate';
    $('st-refine-btn').textContent = on ? 'Working...' : 'Refine';
  }

  // ── Budget line ─────────────────────────────────────────────
  function renderBudget(status) {
    var el = $('st-budget');
    if (!status || !status.enabled) {
      el.textContent = 'Image budget: not set (generation disabled). An owner can set it in Admin.';
      return;
    }
    el.textContent = 'Image budget: $' + Number(status.remainingUsd || 0).toFixed(2) +
      ' remaining of $' + Number(status.budgetUsd || 0).toFixed(2) + ' this cycle.';
  }

  function loadBudget() {
    return fetch(API + '/api/image-studio/budget', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw res; return res.json(); })
      .then(renderBudget)
      .catch(function () { $('st-budget').textContent = ''; });
  }

  // ── Lens + aspect catalog ───────────────────────────────────
  function loadCatalog() {
    return fetch(API + '/api/image-studio/lenses', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw res; return res.json(); })
      .then(function (data) {
        (data.lenses || []).forEach(function (l) {
          var o = document.createElement('option');
          o.value = l.id;
          o.textContent = l.name + ' (' + l.description + ')';
          $('st-lens').appendChild(o);
        });
        (data.aspects || []).forEach(function (a) {
          var o = document.createElement('option');
          o.value = a.id;
          o.textContent = a.label;
          $('st-aspect').appendChild(o);
        });
      })
      .catch(function () { showMessage('Failed to load the lens catalog', 'error'); });
  }

  // ── Library ─────────────────────────────────────────────────
  function loadLibrary() {
    return fetch(API + '/api/image-studio/library?limit=24', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw res; return res.json(); })
      .then(function (data) {
        var grid = $('st-library');
        grid.innerHTML = '';
        var items = data.images || [];
        $('st-library-empty').style.display = items.length === 0 ? '' : 'none';
        items.forEach(function (item) {
          var img = document.createElement('img');
          img.className = 'st-lib-item' + (item.id === selectedId ? ' selected' : '');
          img.src = API + '/api/image-studio/' + item.id + '/serve';
          img.alt = item.human_name || ('Image ' + item.id);
          img.title = (item.human_name || 'Untitled') + (item.lens_id ? (' (' + item.lens_id + ')') : '');
          img.addEventListener('click', function () { select(item.id, item); });
          grid.appendChild(img);
        });
      })
      .catch(function () { showMessage('Failed to load the library', 'error'); });
  }

  // ── Selection + result panel ────────────────────────────────
  function select(id, meta) {
    selectedId = id;
    $('st-result-empty').style.display = 'none';
    $('st-result').style.display = '';
    var url = API + '/api/image-studio/' + id + '/serve';
    $('st-preview').src = url;
    $('st-download').href = url;
    $('st-meta').textContent = meta
      ? ((meta.lens_id ? ('Lens: ' + meta.lens_id + '. ') : '') + (meta.aspect ? ('Shape: ' + meta.aspect + '.') : ''))
      : '';
    var nodes = document.querySelectorAll('.st-lib-item');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('selected');
    loadLibrary();
  }

  // ── Generate ────────────────────────────────────────────────
  function generate() {
    if (busy) return;
    var prompt = $('st-prompt').value.trim();
    if (!prompt) { showMessage('Describe the image first', 'error'); return; }
    var body = { prompt: prompt };
    if ($('st-lens').value) body.lensId = $('st-lens').value;
    if ($('st-aspect').value) body.aspect = $('st-aspect').value;
    setBusy(true);
    fetch(API + '/api/image-studio/generate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { res: res, data: d }; }); })
      .then(function (r) {
        if (!r.res.ok) throw new Error(messageFor(r.res.status, r.data));
        showMessage('Image generated', 'success');
        select(r.data.id, null);
        loadBudget();
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () { setBusy(false); });
  }

  // ── Refine-by-conversation ──────────────────────────────────
  function refine() {
    if (busy || !selectedId) return;
    var instruction = $('st-refine-input').value.trim();
    if (!instruction) { showMessage('Say how to refine it, for example: warmer light', 'error'); return; }
    setBusy(true);
    fetch(API + '/api/image-studio/' + selectedId + '/refine', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instruction })
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { res: res, data: d }; }); })
      .then(function (r) {
        if (!r.res.ok) throw new Error(messageFor(r.res.status, r.data));
        showMessage('Refined into a new image', 'success');
        $('st-refine-input').value = '';
        select(r.data.id, null);
        loadBudget();
      })
      .catch(function (err) { showMessage(err.message, 'error'); })
      .finally(function () { setBusy(false); });
  }

  // ── Access gate + boot ──────────────────────────────────────
  function boot() {
    document.body.classList.remove('om-checking');
    $('loading').style.display = 'none';
    $('app').style.display = '';
    $('st-generate-btn').addEventListener('click', generate);
    $('st-refine-btn').addEventListener('click', refine);
    loadCatalog();
    loadBudget();
    loadLibrary();
  }

  function deny(note) {
    document.body.classList.remove('om-checking');
    $('loading').style.display = 'none';
    if (note) $('denied-note').textContent = note;
    $('denied').style.display = '';
  }

  fetch(API + '/api/image-studio/budget', { credentials: 'include' })
    .then(function (res) {
      if (res.status === 401 || res.status === 403) { deny(null); return null; }
      if (res.status === 402) {
        deny('The Image Studio requires the Business Premium plan for this workspace.');
        return null;
      }
      if (!res.ok) { deny('The Image Studio is unavailable right now.'); return null; }
      boot();
      return null;
    })
    .catch(function () { deny('The Image Studio is unavailable right now.'); });
})();
