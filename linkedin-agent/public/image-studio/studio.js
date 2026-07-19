// =================================================================
// public/image-studio/studio.js - Image Studio (React, 2.5.23)
// =================================================================
// React with JSX, compiled in-browser by babel-standalone exactly
// like the dashboard (the template loads this with type="text/babel").
// The design system lives in studio.css, adapted from the approved
// concept page. Every gated behavior from the vanilla page survives
// verbatim: the budget access probe, the honest 402 entitlement wall,
// the readiness banner naming the missing link, busy-guarded spends,
// additive provenance with the majiklTrust branding, and the same
// endpoint URLs. All fetched values render as text; the HTML
// injection escape hatch is never used anywhere in this file.
// =================================================================

const { useState, useEffect, useCallback } = React;
const API = ''; // same-origin

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

// Lens icons keyed by lens id, mirroring the concept's linework.
const LENS_ICONS = {
  data_hero: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></svg>,
  concept_metaphor: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="9" /></svg>,
  editorial_photo: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="18" height="14" rx="2" /><circle cx="12" cy="13" r="3" /></svg>,
  diagram_real: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="8" y="13" width="7" height="7" rx="1" /></svg>,
  announcement: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 11l18-5v12L3 13z" /></svg>,
  human_moment: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
};

function Topbar({ status }) {
  const keyed = status && status.keyed === true && status.provisioned === true;
  return (
    <div className="topbar">
      <div className="brandmark">MI</div>
      <div className="title-block">
        <h1>Image Studio</h1>
        <div className="sub">Market Intelligence &middot; research-grounded visual storytelling</div>
      </div>
      <div className="spacer"></div>
      {status && status.enabled && (
        <span className="pill"><span className="dot"></span> ${Number(status.remainingUsd || 0).toFixed(2)} budget left</span>
      )}
      <span className={'pill' + (keyed ? '' : ' off')}><span className="dot"></span> {keyed ? 'Image vendor ready' : 'Vendor not ready'}</span>
      <span className="pill premium"><span className="dot"></span> Business Premium</span>
    </div>
  );
}

function ReadinessBanner({ status }) {
  // Provider-onboarding honesty: say WHY generation is not ready.
  if (status && status.provisioned === false) {
    return <div className="grounded warn">Image generation is not ready: an owner needs to choose an Image Model on the Manage page.</div>;
  }
  if (status && status.provisioned === true && status.keyed === false) {
    return <div className="grounded warn">Image generation is not ready: no API key is stored for the selected image vendor. An owner can add one on the Manage page (AI Model Provider).</div>;
  }
  return (
    <div className="grounded">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" /></svg>
      Fidelity lock active &middot; unverified numbers are refused before any spend
    </div>
  );
}

function LensGrid({ lenses, lensId, onPick, busy }) {
  return (
    <div className="lens-grid">
      {lenses.map(function (l) {
        return (
          <div key={l.id} className={'lens' + (lensId === l.id ? ' active' : '')}
            onClick={function () { if (!busy) onPick(lensId === l.id ? null : l.id); }}>
            <div className="lens-ico">{LENS_ICONS[l.id] || LENS_ICONS.concept_metaphor}</div>
            <div className="lens-name">{l.name}</div>
            <div className="lens-desc">{l.description}</div>
          </div>
        );
      })}
    </div>
  );
}

function AspectChips({ aspects, aspect, onPick, busy }) {
  return (
    <div className="row">
      <div className={'aspect' + (aspect === null ? ' active' : '')} onClick={function () { if (!busy) onPick(null); }}>
        Default <span className="dim">square</span>
      </div>
      {aspects.map(function (a) {
        return (
          <div key={a.id} className={'aspect' + (aspect === a.id ? ' active' : '')}
            onClick={function () { if (!busy) onPick(aspect === a.id ? null : a.id); }}>
            {a.label}
          </div>
        );
      })}
    </div>
  );
}

function Provenance({ meta: m }) {
  if (!m) return null;
  var parts = [];
  var src = m.sourceKind === 'post' ? (m.sourcePostId ? ('Grounded in post #' + m.sourcePostId) : 'Grounded in a post')
    : m.sourceKind === 'brief' ? 'From an edited brief'
    : m.sourceKind === 'topic' ? ('From topic #' + m.sourceTopicId)
    : null;
  if (src) parts.push(src + '.');
  if (m.lensId) parts.push('Lens: ' + m.lensId + '.');
  if (m.aspect) parts.push('Shape: ' + m.aspect + '.');
  parts.push('Rendered by ' + m.provider + ' / ' + m.model + '.');
  if (m.costEstimateUsd !== null && m.costEstimateUsd !== undefined) {
    var cost = 'Cost: $' + Number(m.costEstimateUsd).toFixed(4);
    if (m.preSpendEstimateUsd !== null && m.preSpendEstimateUsd !== undefined) {
      cost += ' actual, $' + Number(m.preSpendEstimateUsd).toFixed(4) + ' charged at the gate';
    }
    if (m.outputTokens) cost += ', ' + m.outputTokens + ' output tokens';
    parts.push(cost + '.');
  }
  var branded = m.sourceKind !== 'post' && m.sourceKind !== 'brief' && m.sourceKind !== 'topic';
  return (
    <div className="prov">
      {branded && <span>From majiklTrust<sup>{'\u00A9'}</sup>, Image Studio. </span>}
      {parts.join(' ')}
    </div>
  );
}

function StudioApp() {
  const [gate, setGate] = useState('checking');   // checking | denied | wall | down | ready
  const [status, setStatus] = useState(null);
  const [lenses, setLenses] = useState([]);
  const [aspects, setAspects] = useState([]);
  const [library, setLibrary] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [lensId, setLensId] = useState(null);
  const [aspect, setAspect] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);           // { text, type }
  const [selectedId, setSelectedId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [refineText, setRefineText] = useState('');

  const loadBudget = useCallback(function () {
    return fetch(API + '/api/image-studio/budget', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw res; return res.json(); })
      .then(setStatus)
      .catch(function () {});
  }, []);

  const loadLibrary = useCallback(function () {
    return fetch(API + '/api/image-studio/library?limit=24', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw res; return res.json(); })
      .then(function (data) { setLibrary(data.images || []); })
      .catch(function () { setMsg({ text: 'The library failed to load.', type: 'err' }); });
  }, []);

  function loadProvenance(id) {
    fetch(API + '/api/image-studio/' + id + '/meta', { credentials: 'include' })
      .then(function (res) { if (!res.ok) throw res; return res.json(); })
      .then(setMeta)
      .catch(function () { /* provenance is additive; the image still shows */ setMeta(null); });
  }

  useEffect(function () {
    fetch(API + '/api/image-studio/budget', { credentials: 'include' })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { setGate('denied'); return null; }
        if (res.status === 402) { setGate('wall'); return null; }
        if (!res.ok) { setGate('down'); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        setStatus(data);
        setGate('ready');
        fetch(API + '/api/image-studio/lenses', { credentials: 'include' })
          .then(function (res) { return res.json(); })
          .then(function (cat) { setLenses(cat.lenses || []); setAspects(cat.aspects || []); })
          .catch(function () { setMsg({ text: 'The lens catalog failed to load.', type: 'err' }); });
        loadLibrary();
      })
      .catch(function () { setGate('down'); });
  }, [loadLibrary]);

  function select(id) {
    setSelectedId(id);
    setMeta(null);
    loadProvenance(id);
  }

  function generate() {
    if (busy) return;
    var text = prompt.trim();
    if (!text) { setMsg({ text: 'Describe the image first.', type: 'err' }); return; }
    var body = { prompt: text };
    if (lensId) body.lensId = lensId;
    if (aspect) body.aspect = aspect;
    setBusy(true); setMsg(null);
    fetch(API + '/api/image-studio/generate', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { res: res, data: d }; }); })
      .then(function (r) {
        if (!r.res.ok) throw new Error(messageFor(r.res.status, r.data));
        setMsg({ text: 'Image generated.', type: 'ok' });
        select(r.data.id);
        loadLibrary(); loadBudget();
      })
      .catch(function (err) { setMsg({ text: err.message, type: 'err' }); })
      .finally(function () { setBusy(false); });
  }

  function refine() {
    if (busy || !selectedId) return;
    var instruction = refineText.trim();
    if (!instruction) { setMsg({ text: 'Say how to refine it, for example: warmer light.', type: 'err' }); return; }
    setBusy(true); setMsg(null);
    fetch(API + '/api/image-studio/' + selectedId + '/refine', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instruction })
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { res: res, data: d }; }); })
      .then(function (r) {
        if (!r.res.ok) throw new Error(messageFor(r.res.status, r.data));
        setMsg({ text: 'Refined into a new image.', type: 'ok' });
        setRefineText('');
        select(r.data.id);
        loadLibrary(); loadBudget();
      })
      .catch(function (err) { setMsg({ text: err.message, type: 'err' }); })
      .finally(function () { setBusy(false); });
  }

  if (gate === 'checking') {
    return <div className="gate"><h1>Image Studio</h1><p>Checking access...</p></div>;
  }
  if (gate === 'denied') {
    return <div className="gate"><h1>Access denied</h1><p>You need to be signed in to a workspace to use the Image Studio.</p><p><a href="/app">Back to dashboard</a></p></div>;
  }
  if (gate === 'wall') {
    return <div className="gate"><h1>Business Premium</h1><p>The Image Studio requires the Business Premium plan for this workspace.</p><p><a href="/app/billing/">See plans on the Billing page</a></p></div>;
  }
  if (gate === 'down') {
    return <div className="gate"><h1>Unavailable</h1><p>The Image Studio is unavailable right now.</p><p><a href="/app">Back to dashboard</a></p></div>;
  }

  var serveUrl = selectedId ? (API + '/api/image-studio/' + selectedId + '/serve') : null;
  return (
    <React.Fragment>
      <Topbar status={status} />
      <div className="studio">
        <div className="panel">
          <h2>Visual brief <span className="hint">yours to write</span></h2>
          <ReadinessBanner status={status} />
          <div className="brief">
            <span className="edit-flag">editable</span>
            <textarea value={prompt} disabled={busy}
              onChange={function (e) { setPrompt(e.target.value); }}
              placeholder="A resilient supply network weathering a storm" />
          </div>
          <div className="section-gap">
            <h2>Story lens <span className="hint">{lensId ? '1 selected' : 'optional'}</span></h2>
            <LensGrid lenses={lenses} lensId={lensId} onPick={setLensId} busy={busy} />
          </div>
          <div className="section-gap">
            <h2>Shape</h2>
            <AspectChips aspects={aspects} aspect={aspect} onPick={setAspect} busy={busy} />
          </div>
          {status && status.enabled === false && (
            <div className="budget-line">Image budget: not set. Generation is disabled until an owner sets it in Admin.</div>
          )}
          {status && status.enabled && (
            <div className="budget-line">Budget: <b>${Number(status.remainingUsd || 0).toFixed(2)}</b> remaining of ${Number(status.budgetUsd || 0).toFixed(2)} this cycle.</div>
          )}
        </div>

        <div className="panel">
          <div className="gallery-head">
            <div className="lead">Library <span>&middot; every render this workspace keeps</span></div>
            <div className="spacer"></div>
            <button className="gen-btn" disabled={busy} onClick={generate}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" /></svg>
              {busy ? 'Working...' : 'Generate'}
            </button>
          </div>
          {msg && <div className={'msg-line ' + (msg.type === 'ok' ? 'ok' : 'err')}>{msg.text}</div>}
          {library.length === 0 && <div className="empty-note">Nothing here yet. Write a visual brief and generate your first image.</div>}
          <div className="variants">
            {library.map(function (item) {
              return (
                <div key={item.id} className={'tile' + (selectedId === item.id ? ' selected' : '')}
                  onClick={function () { select(item.id); }}>
                  {item.lens_id && <span className="lens-tag">{item.lens_id}</span>}
                  <span className="pick"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg></span>
                  <img src={API + '/api/image-studio/' + item.id + '/serve'} alt={item.human_name || ('Image ' + item.id)} loading="lazy" />
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2>Selected <span className="hint">{selectedId ? ('#' + selectedId) : ''}</span></h2>
          {!selectedId && <div className="empty-note">Pick an image from the library, or generate one.</div>}
          {selectedId && (
            <React.Fragment>
              <img className="preview" src={serveUrl} alt="Selected image" />
              <Provenance meta={meta} />
              <div className="refine-row">
                <input type="text" maxLength={500} value={refineText} disabled={busy}
                  onChange={function (e) { setRefineText(e.target.value); }}
                  placeholder="Refine: warmer light, less clutter" />
                <button className="btn-quiet" disabled={busy} onClick={refine}>Refine</button>
              </div>
              <div className="dl-row">
                <a className="btn-quiet" href={serveUrl} download>Download</a>
              </div>
            </React.Fragment>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<StudioApp />);
