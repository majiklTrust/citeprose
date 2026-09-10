// ================================================================
// showcase-poc.js  (delivery 3.3.29)
// ================================================================
// Drives the showcase replays at the top of the marketing homepage
// (site_templates/alpha-index.html, #showcase-pos). Five recordings live
// in one window; a tab row picks which one plays. Only the active
// recording runs; switching stops the other, resets it, and starts
// the chosen one from its first frame.
//
//   "create"  1. Generate: click Generate in Quick Actions, the Generating
//                Content overlay shows while the caption walks research,
//                drafting and quality review, then the draft preview opens
//                with Sources Referenced and the Quality Assessment, and
//                Queue for Approval puts it in the queue.
//             2. Edit: click Edit on the queued card, the Edit Post modal
//                opens, the Content field takes focus, Save Changes is
//                clicked.
//             3. Publish: click the card, the post detail modal opens, it
//                scrolls to the actions, Publish is clicked, the queue and
//                the stat cards reflect it.
//
//   "topics"  1. Topics page: + Add Topic, type the name and the one
//                sentence description, Generate Suggestions (angles and
//                hashtags fill in), Save Topic, the card appears under
//                My Topics.
//             2. Discover Feeds on the new card: the discovery modal
//                asks the model for feeds and validates each one, three
//                rows come back checked, Add Selected Feeds maps them.
//             3. Dashboard: pick the new topic and one of its angles in
//                Quick Actions, Generate, the Generating Content overlay
//                shows, the Research Monitor narrows to the topic, then
//                the draft modal opens with Sources Referenced and the
//                Quality Assessment, ending on Queue for Approval.
//
//   "analytics" 1. Analytics page: the cursor walks Advocacy Program
//                Intelligence, Advocacy Amplification, Posts, Performance
//                by Topic, the Posting Time Heatmap and Follower
//                Demographics, scrolling the page, then asks for the
//                Narrative summary, which appears with every claim cited.
//             2. Advocacy page: My Participation, the Members table, a
//                source post is selected and Generate Variant Post runs
//                behind the gate chain, the member's personalized variant
//                lands in the Post Variants Queue and is approved.
//
//   "linkedin" 1. LinkedIn Connection page, nothing connected: the
//                status rows are all off, Publish as has no setting and
//                the Organization Page toggle is disabled. Reconnect
//                LinkedIn starts the single OAuth grant.
//             2. The authorization step: the broker allows the listed
//                permissions.
//             3. Back on the page: connected, refresh token on file,
//                person URN and expiries filled in, personal profile is
//                the default destination. Discovery links the brokerage
//                page, the Organization Page toggle unlocks, Publish as
//                switches to the page and back to the profile.
//
//   "imagestudio" 1. Dashboard: Edit on the post waiting for approval.
//             2. Edit Post modal, in-post Image Studio panel: Story Lens,
//                a typed prompt, Generate (Working...), the budget gate,
//                the render, Attach to Post, Save Changes; the queue
//                card gains a thumbnail.
//             3. Post detail modal shows the attached image; Publish.
//             4. The post as it appears in the feed, picture and all.
//
// Behavior
//   - Plays automatically at PLAYBACK_RATE (0.4x).
//   - Holds for END_PAUSE_MS (3000, wall time) on the final frame,
//     resets, and repeats forever.
//   - A player bar below the window: restart, play or pause, a seekable
//     progress bar (click, or arrow keys when focused) and a time
//     readout in wall clock seconds. Pausing freezes the recording
//     clock, so scheduled steps and the deferred hover and typing
//     callbacks wait too; only a CSS transition already in flight
//     finishes. Seeking rebuilds the frame instantly by replaying every
//     step up to the target with transitions suppressed.
//   - Cursor travel, click ripple, modal fades and the caption in the
//     window bar are scaled by the same rate through --spos-rate, set on
//     the section by this script and read by showcase-poc.css.
//
// Captions
//   The "create" and "topics" recordings narrate in plain language: what
//   the person is doing and why it matters, in the tenant's own terms.
//   The "analytics" recording narrates the numbers the same way. No
//   selectors or API paths appear in the window bar. Every caption is
//   concise and direct and stays within 105 visible characters
//   (tags excluded, spaces and punctuation included).
//
// Constraints honored
//   - Page CSP is script-src 'self' and style-src 'self'. This file is
//     loaded by src, never inlined. Geometry is written through the
//     CSSOM, never through a style attribute. Tab clicks are bound with
//     addEventListener, never inline handlers.
//   - Nothing here reads user input or network data. Caption text and
//     typed text are fixed tables in this file, so innerHTML carries
//     only literals.
//   - Idempotent: if #showcase-pos is absent, or any element a
//     recording drives is missing, that recording is skipped and its
//     tab is disabled rather than throwing.
//   - requestAnimationFrame stops in background tabs; the frame delta
//     is clamped so a returning tab resumes where it paused.
//   - Deferred callbacks (hover follow-ups, typing, button states) are
//     scheduled on the recording clock, not on setTimeout, so they
//     pause with the clock and are dropped on stop and reset. Switching
//     mid scene leaves no stray callback.
//   - No forced reflows (3.3.26). The engine never reads layout right
//     after writing it: the window width comes from a ResizeObserver
//     rather than clientWidth; transition and animation restarts use
//     the next animation frame or the Web Animations API rather than
//     the "void el.offsetWidth" trick; and a tab switch lets the
//     browser lay out the newly shown stage on its own frame before the
//     recording starts and measures anything. Geometry reads for the
//     cursor (getBoundingClientRect) happen inside steps, spaced by the
//     script, never in the same task as a display toggle.
// ================================================================

(function () {
  'use strict';

  var PLAYBACK_RATE = 0.4;   // 1 = real time
  var END_PAUSE_MS = 3000;   // wall time, not scaled
  var STAGE_W = 1000;        // under the dashboard 1100px breakpoint: two column grid
  var STAGE_H = 620;
  var MAX_FRAME_DELTA_MS = 100;

  var root = document.getElementById('showcase-pos');
  if (!root) return;

  var frame = root.querySelector('.spos-frame');
  var callout = root.querySelector('.spos-callout');
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.spos-tab[data-recording]'));
  var playBtn = root.querySelector('.spos-ctl-play');
  var restartBtn = root.querySelector('.spos-ctl-restart');
  if (!frame || !callout) return;

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.style.setProperty('--spos-rate', String(PLAYBACK_RATE));

  // Window width, observed rather than measured, so fit() is write-only.
  // The observer reports the frame's size after layout, with no forced
  // reflow; until its first report the width is read once at startup.
  var frameWidth = 0;
  var onFrameResize = null;
  if (window.ResizeObserver) {
    new ResizeObserver(function (entries) {
      var w = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
      if (w && w !== frameWidth) { frameWidth = w; if (onFrameResize) onFrameResize(); }
    }).observe(frame);
  }
  function nextFrame(fn) { window.requestAnimationFrame(function () { window.requestAnimationFrame(fn); }); }

  // Shared caption in the window bar.
  function say(html) { callout.innerHTML = html; callout.classList.add('spos-on'); }
  function hush() { callout.classList.remove('spos-on'); }

  // ---------- One recording ----------
  // recEl: the .spos-recording wrapper. build(h): returns
  // { script, duration, reset, required, start, reducedMotion } using the helpers h.
  function makeRecording(recEl, build) {
    var scaler = recEl.querySelector('.spos-scaler');
    var stage = recEl.querySelector('.spos-stage');
    var cursor = recEl.querySelector('.spos-cursor');
    var ripple = recEl.querySelector('.spos-ripple');
    var hl = recEl.querySelector('.spos-highlight');
    if (!scaler || !stage || !cursor || !ripple || !hl) return null;

    // Deferred work runs on the recording clock (scaled ms), so it
    // pauses with playback and is discarded by clearPending().
    var pending = [], clock = 0;
    function later(fn, ms) { pending.push({ due: clock + ms, fn: fn }); }
    function clearPending() { pending = []; }
    function runPending() {
      var ready = pending.filter(function (p) { return p.due <= clock; });
      if (!ready.length) return;
      pending = pending.filter(function (p) { return p.due > clock; });
      ready.sort(function (a, b) { return a.due - b.due; });
      for (var i = 0; i < ready.length; i++) ready[i].fn();
    }

    function fit() {
      if (!frameWidth) frameWidth = frame.clientWidth;  // startup only, before the observer reports
      var s = Math.min(1, frameWidth / STAGE_W);
      stage.style.transform = 'scale(' + s + ')';
      scaler.style.height = (STAGE_H * s) + 'px';
    }
    function scaleNow() { return stage.getBoundingClientRect().width / STAGE_W; }
    function center(el, dx, dy) {
      var r = el.getBoundingClientRect(), s = stage.getBoundingClientRect(), k = scaleNow();
      return { x: (r.left - s.left) / k + r.width / 2 + (dx || 0), y: (r.top - s.top) / k + r.height / 2 + (dy || 0) };
    }
    function box(el, pad) {
      var r = el.getBoundingClientRect(), s = stage.getBoundingClientRect(), k = scaleNow(), p = pad == null ? 6 : pad;
      return { x: (r.left - s.left) / k - p, y: (r.top - s.top) / k - p, w: r.width / k + p * 2, h: r.height / k + p * 2 };
    }
    function moveCursor(p, fast) {
      cursor.classList.remove('spos-jump');
      cursor.classList.toggle('spos-fast', !!fast);
      cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
    }
    function jumpCursor(p) {
      // Suppress the transition for this move; lift the suppression on
      // a later frame once the new position has been applied.
      cursor.classList.add('spos-jump');
      cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
      nextFrame(function () { cursor.classList.remove('spos-jump'); });
    }
    function clickAt(p) {
      ripple.style.left = p.x + 'px'; ripple.style.top = p.y + 'px';
      if (ripple.animate) {
        // Web Animations restart cleanly without a reflow; duration follows the playback rate.
        ripple.animate([{ opacity: 0.9, transform: 'scale(0.6)' }, { opacity: 0, transform: 'scale(4.2)' }],
          { duration: 550 / PLAYBACK_RATE, easing: 'ease-out', fill: 'forwards' });
      } else {
        ripple.classList.remove('spos-go');
        window.requestAnimationFrame(function () { ripple.classList.add('spos-go'); });
      }
    }
    function showBox(el) {
      var b = box(el);
      hl.style.left = b.x + 'px'; hl.style.top = b.y + 'px'; hl.style.width = b.w + 'px'; hl.style.height = b.h + 'px';
      hl.classList.add('spos-on');
    }
    function hideBox() { hl.classList.remove('spos-on'); }
    function q(sel) { return recEl.querySelector(sel); }
    function qAll(sel) { return recEl.querySelectorAll(sel); }

    function hoverStep(el, dx, dy, fast, caption) {
      return function () {
        moveCursor(center(el, dx, dy), fast);
        later(function () { el.classList.add('spos-hover'); showBox(el); say(caption); }, 520);
      };
    }
    function clickStep(el, dx, dy, caption) {
      return function () {
        el.classList.add('spos-pressed');
        clickAt(center(el, dx, dy));
        say(caption);
        later(function () { el.classList.remove('spos-pressed'); }, 140);
      };
    }
    // Type `text` into the .spos-tp-typed child of `inputEl`, one
    // character per `perChar` ms at 1x.
    function typeStep(inputEl, text, perChar) {
      return function () {
        var out = inputEl.querySelector('.spos-tp-typed');
        if (!out) return;
        inputEl.classList.add('spos-focus', 'spos-typed-on');
        out.textContent = '';
        for (var i = 1; i <= text.length; i++) {
          (function (n) { later(function () { out.textContent = text.slice(0, n); }, perChar * n); })(i);
        }
      };
    }

    var h = { q: q, qAll: qAll, later: later, center: center, moveCursor: moveCursor, jumpCursor: jumpCursor, clickAt: clickAt,
      showBox: showBox, hideBox: hideBox, say: say, hush: hush, hoverStep: hoverStep, clickStep: clickStep, typeStep: typeStep };
    var built = build(h);
    if (!built) return null;
    for (var i = 0; i < built.required.length; i++) { if (!built.required[i]) return null; }

    // phase: 'stopped' | 'playing' | 'holding' (end pause) | 'paused'
    var elapsed = 0, lastTs = 0, fired = [], phase = 'stopped', raf = 0, holdLeft = 0, resumePhase = 'playing';
    function reset() {
      clearPending(); fired = []; elapsed = 0; clock = 0; lastTs = 0; holdLeft = 0;
      hideBox(); hush();
      built.reset();
      jumpCursor(built.start);
    }
    function tick(ts) {
      if (phase !== 'playing' && phase !== 'holding') return;
      var dt = lastTs ? Math.min(ts - lastTs, MAX_FRAME_DELTA_MS) : 0;
      lastTs = ts;
      if (phase === 'holding') {
        holdLeft -= dt;
        if (holdLeft <= 0) { reset(); phase = 'playing'; }
        raf = window.requestAnimationFrame(tick);
        return;
      }
      elapsed += dt * PLAYBACK_RATE; clock = elapsed;
      for (var i = 0; i < built.script.length; i++) {
        if (!fired[i] && elapsed >= built.script[i].t) { fired[i] = true; built.script[i].run(); }
      }
      runPending();
      if (elapsed >= built.duration) { phase = 'holding'; holdLeft = END_PAUSE_MS; }
      raf = window.requestAnimationFrame(tick);
    }
    function play() {
      if (phase === 'playing' || phase === 'holding') return;
      if (phase === 'paused') { phase = resumePhase; lastTs = 0; raf = window.requestAnimationFrame(tick); notify(); return; }
      reset(); phase = 'playing'; lastTs = 0; raf = window.requestAnimationFrame(tick); notify();
    }
    function pause() {
      if (phase !== 'playing' && phase !== 'holding') return;
      resumePhase = phase; phase = 'paused';
      if (raf) window.cancelAnimationFrame(raf); raf = 0;
      notify();
    }
    function restart() { stop(); play(); }
    function start() {
      fit();
      if (reducedMotion) { reset(); built.reducedMotion(); phase = 'stopped'; notify(); return; }
      phase = 'stopped'; play();
    }
    function stop() {
      phase = 'stopped';
      if (raf) window.cancelAnimationFrame(raf); raf = 0;
      reset();
    }
    function isPlaying() { return phase === 'playing' || phase === 'holding'; }
    function progress() { return { elapsed: Math.min(elapsed, built.duration), duration: built.duration, phase: phase }; }
    // Jump to `t` (scaled ms): rebuild the frame by replaying every step
    // up to t with transitions suppressed, then continue in the state
    // playback was in (playing stays playing, paused stays paused).
    function seek(t) {
      var wasPlaying = isPlaying() || phase === 'stopped';
      if (raf) window.cancelAnimationFrame(raf); raf = 0;
      stage.classList.add('spos-seeking');
      reset();
      elapsed = Math.max(0, Math.min(t, built.duration));
      for (var i = 0; i < built.script.length; i++) {
        if (built.script[i].t <= elapsed) { fired[i] = true; clock = built.script[i].t; built.script[i].run(); }
      }
      clock = elapsed;
      runPending();
      nextFrame(function () { stage.classList.remove('spos-seeking'); });
      lastTs = 0; resumePhase = 'playing';
      if (wasPlaying && !reducedMotion) { phase = 'playing'; raf = window.requestAnimationFrame(tick); } else { phase = 'paused'; }
      notify();
    }
    function notify() { if (onState) onState(); }
    var onState = null;
    function onStateChange(fn) { onState = fn; }
    return { start: start, stop: stop, fit: fit, play: play, pause: pause, restart: restart, seek: seek, progress: progress, isPlaying: isPlaying, onStateChange: onStateChange };
  }

  // ---------- Recording "create" ----------
  function buildCreate(h) {
    var btnGenerate = h.q('.spos-btn-generate'), quickActions = h.q('.spos-quick-actions');
    var genOverlay = h.q('.spos-c-gen-overlay'), draftOverlay = h.q('.spos-c-draft-overlay'), draftModal = h.q('.spos-c-draft-modal'), queueBtn = h.q('.spos-c-queue-btn');
    var pendingCard = h.q('.spos-pending-card'), editBtn = h.q('.spos-edit-btn');
    var editOverlay = h.q('.spos-edit-overlay'), editTextarea = h.q('.spos-edit-textarea'), editSave = h.q('.spos-edit-save');
    var detailOverlay = h.q('.spos-detail-overlay'), detailModal = h.q('.spos-detail-modal'), publishBtn = h.q('.spos-publish-btn');
    var pendingStatus = h.q('.spos-pending-status'), pendingActions = h.q('.spos-pending-actions'), queueBadge = h.q('.spos-queue-badge');
    var statPublished = h.q('.spos-stat-published'), statPending = h.q('.spos-stat-pending');
    var required = [btnGenerate, quickActions, genOverlay, draftOverlay, draftModal, queueBtn, pendingCard, editBtn, editOverlay, editTextarea, editSave,
      detailOverlay, detailModal, publishBtn, pendingStatus, pendingActions, queueBadge, statPublished, statPending];
    var START = { x: 300, y: 600 };
    var script = [
      // Scene 1: Generate
      { t: 0, run: function () { h.jumpCursor(START); h.say('Monday at the shop. The queue is empty and the week needs a post.'); } },
      { t: 900, run: function () { h.moveCursor(h.center(quickActions, 0, -40)); } },
      { t: 2000, run: h.hoverStep(btnGenerate, -4, 2, true, '<b>Generate</b>: research, draft, then a second opinion. No topic chosen, so the agent takes the one due.') },
      { t: 3600, run: h.clickStep(btnGenerate, -4, 2, 'Go.') },
      { t: 3850, run: function () { btnGenerate.classList.remove('spos-hover'); h.hideBox(); genOverlay.classList.add('spos-open'); h.say('<b>Generating Content.</b> Auto-select picked Customer Loyalty. The draft saves as it goes.'); } },
      { t: 5300, run: function () { h.say('Research: <b>two shopper studies, two trade sources</b>, checked against each other first.'); } },
      { t: 6900, run: function () { h.say('Drafted in the voice of the store, from the prompt the store keeps in its vault.'); } },
      { t: 8400, run: function () { h.say('Quality review: <b>8 of 10, pass</b>. A second, independent opinion.'); } },
      { t: 9600, run: function () { genOverlay.classList.remove('spos-open'); draftModal.scrollTop = 0; draftOverlay.classList.add('spos-open'); h.say('A draft, with its <b>sources and its scores</b> attached.'); } },
      { t: 10700, run: function () { h.moveCursor(h.center(draftModal, 60, 40)); } },
      { t: 11800, run: function () { h.say('<b>Sources Referenced</b>: four, tiered, every one behind a claim in the post.'); draftModal.scrollTop = Math.round(draftModal.scrollHeight * 0.45); } },
      { t: 13500, run: function () { h.say('<b>Quality Assessment</b>: hook, authenticity, source grounding, factual caution.'); draftModal.scrollTop = draftModal.scrollHeight; } },
      { t: 15000, run: h.hoverStep(queueBtn, 0, 0, true, '<b>Queue for Approval</b>. The draft waits for a person.') },
      { t: 16100, run: h.clickStep(queueBtn, 0, 0, 'Queued.') },
      { t: 16350, run: function () {
        queueBtn.classList.remove('spos-hover'); h.hideBox(); draftOverlay.classList.remove('spos-open');
        pendingCard.classList.remove('spos-c-hidden'); pendingCard.classList.add('spos-enter');
        h.later(function () { pendingCard.classList.remove('spos-enter'); }, 60);
        queueBadge.textContent = '1'; statPending.textContent = '1';
        h.say('<b>Points are not loyalty</b> is in the queue, pending approval.');
      } },
      // Scene 2: Edit
      { t: 17700, run: function () { h.moveCursor(h.center(pendingCard, -40, 0)); } },
      { t: 18900, run: h.hoverStep(editBtn, 0, 0, true, 'Edit before it goes anywhere.') },
      { t: 20100, run: h.clickStep(editBtn, 0, 0, 'Open it up.') },
      { t: 20350, run: function () { editBtn.classList.remove('spos-hover'); h.hideBox(); editOverlay.classList.add('spos-open'); h.say('Title, body, hashtags, a picture if needed. <b>Nothing publishes on its own.</b>'); } },
      { t: 21400, run: function () { h.moveCursor(h.center(editTextarea, 120, 40)); } },
      { t: 22500, run: h.clickStep(editTextarea, 120, 40, 'A word here, a line there. The draft stays a draft while it is being shaped.') },
      { t: 22700, run: function () { editTextarea.classList.add('spos-focus'); } },
      { t: 24300, run: function () { editTextarea.classList.remove('spos-focus'); h.moveCursor(h.center(editSave, 0, 0)); } },
      { t: 25400, run: h.hoverStep(editSave, 0, 0, true, '<b>Save Changes</b> keeps it in the queue, edited, still waiting for a person.') },
      { t: 26400, run: h.clickStep(editSave, 0, 0, 'Saved.') },
      { t: 26650, run: function () { editSave.classList.remove('spos-hover'); h.hideBox(); editOverlay.classList.remove('spos-open'); h.say('The edit is in. Now the decision.'); } },
      // Scene 3: Publish from the post detail modal
      { t: 27700, run: h.hoverStep(pendingCard, -60, -6, false, 'Open the post itself to see what it was built from.') },
      { t: 29100, run: h.clickStep(pendingCard, -60, -6, 'The whole story, with its receipts.') },
      { t: 29350, run: function () { pendingCard.classList.remove('spos-hover'); h.hideBox(); detailModal.scrollTop = 0; detailOverlay.classList.add('spos-open'); h.say('<b>Strong corroboration</b>: four sources agreed before a word was written.'); } },
      { t: 30500, run: function () { h.moveCursor(h.center(detailModal, 80, 20)); } },
      { t: 31600, run: function () { h.say('Sources listed. Image chosen. Everything a reviewer needs is on one screen.'); detailModal.scrollTop = detailModal.scrollHeight; } },
      { t: 32600, run: h.hoverStep(publishBtn, 0, 0, true, '<b>Publish</b> sends it to the organization page. Once, and only when a person says so.') },
      { t: 33900, run: h.clickStep(publishBtn, 0, 0, 'Approved by a person. Published by the platform.') },
      { t: 34150, run: function () { publishBtn.classList.remove('spos-hover'); h.hideBox(); detailOverlay.classList.remove('spos-open'); h.say('From pending to posted.'); } },
      { t: 34700, run: function () {
        pendingStatus.textContent = 'posted'; pendingStatus.classList.add('spos-status-posted');
        pendingActions.style.visibility = 'hidden'; pendingCard.classList.add('spos-published');
        queueBadge.textContent = '0'; statPending.textContent = '0'; statPublished.textContent = '28';
        h.say('<b>Twenty eight published.</b> Queue empty. Back to the floor.');
      } },
      { t: 35900, run: function () { h.moveCursor(START); } },
      { t: 36700, run: function () { h.say('End of recording.'); } }
    ];
    function reset() {
      genOverlay.classList.remove('spos-open'); draftOverlay.classList.remove('spos-open'); editOverlay.classList.remove('spos-open'); detailOverlay.classList.remove('spos-open');
      draftModal.scrollTop = 0; detailModal.scrollTop = 0;
      var touched = [btnGenerate, queueBtn, editBtn, editSave, pendingCard, publishBtn, editTextarea];
      for (var i = 0; i < touched.length; i++) { touched[i].classList.remove('spos-hover', 'spos-pressed', 'spos-focus'); }
      pendingCard.classList.add('spos-c-hidden'); pendingCard.classList.remove('spos-enter', 'spos-published');
      pendingStatus.textContent = 'pending approval'; pendingStatus.classList.remove('spos-status-posted');
      pendingActions.style.visibility = '';
      queueBadge.textContent = '0'; statPending.textContent = '0'; statPublished.textContent = '27';
    }
    return { script: script, duration: 37700, reset: reset, required: required, start: START,
      reducedMotion: function () { draftOverlay.classList.add('spos-open'); } };
  }

  // ---------- Recording "topics" ----------
  function buildTopics(h) {
    var screenTopics = h.q('.spos-t-screen-topics'), screenDash = h.q('.spos-t-screen-dash');
    var addTopic = h.q('.spos-t-add-topic'), createForm = h.q('.spos-t-create-form'), nameIn = h.q('.spos-t-name'), descIn = h.q('.spos-t-desc');
    var suggest = h.q('.spos-t-suggest'), result = h.q('.spos-t-result'), save = h.q('.spos-t-save'), msg = h.q('.spos-t-msg'), newCard = h.q('.spos-t-new-card');
    var navDash = h.q('.spos-t-nav-dashboard');
    var discoverLink = h.q('.spos-t-discover-link'), mappedCount = h.q('.spos-t-mapped-count');
    var dOverlay = h.q('.spos-t-discover-overlay'), dSubtitle = h.q('.spos-t-discover-subtitle'), dLoading = h.q('.spos-t-discover-loading');
    var dResults = h.q('.spos-t-discover-results'), dRow1 = h.q('.spos-t-dfeed-1'), dActions = h.q('.spos-t-discover-actions'), dAdd = h.q('.spos-t-discover-add');
    var newFeeds = Array.prototype.slice.call(h.qAll('.spos-t-new-feed'));
    var quickActions = h.q('.spos-t-quick-actions'), topicSel = h.q('.spos-t-topic-select'), angleSel = h.q('.spos-t-angle-select'), generate = h.q('.spos-t-generate');
    var monitor = h.q('.spos-t-monitor'), monitorScope = h.q('.spos-t-monitor-scope'), monitorUsing = h.q('.spos-t-monitor-using'), feedList = h.q('.spos-t-feed-list');
    var genOverlay = h.q('.spos-t-gen-overlay'), draftOverlay = h.q('.spos-t-draft-overlay'), draftModal = h.q('.spos-t-draft-modal'), queueBtn = h.q('.spos-t-queue-btn');
    var required = [screenTopics, screenDash, addTopic, createForm, nameIn, descIn, suggest, result, save, msg, newCard, navDash,
      discoverLink, mappedCount, dOverlay, dSubtitle, dLoading, dResults, dRow1, dActions, dAdd,
      quickActions, topicSel, angleSel, generate, monitor, monitorScope, monitorUsing, feedList, genOverlay, draftOverlay, draftModal, queueBtn];
    var START = { x: 300, y: 600 };
    var NAME = 'Emergency Savings Habits';
    var DESC = 'How everyday savers build a cushion, and what a bank can do to make it easier';
    var feedRows = feedList ? Array.prototype.slice.call(feedList.querySelectorAll('.spos-feed-row:not(.spos-t-new-feed)')) : [];
    var script = [
      // Scene 1: the Topics page
      { t: 0, run: function () { h.jumpCursor(START); h.say('A community bank wants to talk about saving. Every post starts with a <b>topic</b>.'); } },
      { t: 900, run: h.hoverStep(addTopic, 0, 0, false, '<b>+ Add Topic</b>. A topic is what the agent researches and writes about.') },
      { t: 2200, run: h.clickStep(addTopic, 0, 0, 'Name it. Describe it in one sentence.') },
      { t: 2450, run: function () { addTopic.classList.remove('spos-hover'); h.hideBox(); createForm.classList.add('spos-open'); h.say('Two fields are enough to start.'); } },
      { t: 3300, run: function () { h.moveCursor(h.center(nameIn, -120, 0), true); } },
      { t: 4000, run: h.clickStep(nameIn, -120, 0, '<b>Emergency Savings Habits.</b>') },
      { t: 4200, run: h.typeStep(nameIn, NAME, 70) },
      { t: 6000, run: function () { nameIn.classList.remove('spos-focus'); h.moveCursor(h.center(descIn, -120, 0), true); } },
      { t: 6700, run: h.clickStep(descIn, -120, 0, 'How everyday savers build a cushion, and what a bank can do to make it easier.') },
      { t: 6900, run: h.typeStep(descIn, DESC, 45) },
      { t: 9800, run: function () { descIn.classList.remove('spos-focus'); h.moveCursor(h.center(suggest, 0, 0), true); } },
      { t: 10600, run: h.hoverStep(suggest, 0, 0, true, '<b>Generate Suggestions</b> asks the model for angles and hashtags that fit.') },
      { t: 11500, run: h.clickStep(suggest, 0, 0, 'One request.') },
      { t: 11750, run: function () { suggest.classList.remove('spos-hover'); h.hideBox(); suggest.classList.add('spos-busy'); suggest.textContent = 'Generating...'; h.say('The model reads the sentence and proposes four ways into the subject.'); } },
      { t: 13600, run: function () { suggest.classList.remove('spos-busy'); suggest.textContent = 'Generate Suggestions'; result.classList.add('spos-open'); h.say('<b>Four angles, three hashtags</b>, a weight of one. Edit any of them, or keep them.'); } },
      { t: 14700, run: function () { h.moveCursor(h.center(save, 0, 0)); } },
      { t: 15800, run: h.hoverStep(save, 0, 0, true, '<b>Save Topic</b>.') },
      { t: 16700, run: h.clickStep(save, 0, 0, 'Saved.') },
      { t: 16950, run: function () {
        save.classList.remove('spos-hover'); h.hideBox();
        createForm.classList.remove('spos-open'); result.classList.remove('spos-open');
        msg.textContent = 'Topic created'; msg.classList.add('spos-on');
        newCard.classList.add('spos-shown', 'spos-enter');
        h.later(function () { newCard.classList.remove('spos-enter'); }, 60);
        h.say('Listed under My Topics. <b>Zero feeds mapped</b>, for now.');
      } },
      // Scene 2: feed discovery for the new topic
      { t: 18200, run: function () { h.moveCursor(h.center(discoverLink, 0, 0)); } },
      { t: 19300, run: h.hoverStep(discoverLink, 0, 0, true, '<b>Discover Feeds</b>: the model finds sources for the topic, so nobody hunts by hand.') },
      { t: 20200, run: h.clickStep(discoverLink, 0, 0, 'Searching.') },
      { t: 20450, run: function () { discoverLink.classList.remove('spos-hover'); h.hideBox(); dOverlay.classList.add('spos-open'); h.say('The model proposes candidate feeds.'); } },
      { t: 21700, run: function () { h.say('Then the platform checks its work.'); } },
      { t: 23000, run: function () { h.say('Each candidate is <b>fetched, parsed and graded</b> first. Broken feeds never reach the list.'); } },
      { t: 24400, run: function () { dLoading.classList.add('spos-done'); dResults.classList.add('spos-open'); dActions.classList.add('spos-open'); dSubtitle.textContent = '3 validated feeds found'; h.say('<b>Three validated feeds</b>, all selected, each with a reason and a recent headline.'); } },
      { t: 25500, run: h.hoverStep(dRow1, 0, 0, true, '<b>Savings Habit Lab</b>: primary tier, strongest on automatic transfers and first balances.') },
      { t: 27000, run: function () { dRow1.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(h.center(dAdd, 0, 0)); } },
      { t: 28000, run: h.hoverStep(dAdd, 0, 0, true, '<b>Add Selected Feeds</b>.') },
      { t: 28900, run: h.clickStep(dAdd, 0, 0, 'Adding.') },
      { t: 29150, run: function () { dAdd.classList.remove('spos-hover'); h.hideBox(); dAdd.classList.add('spos-busy'); dAdd.textContent = 'Adding...'; } },
      { t: 30300, run: function () {
        dOverlay.classList.remove('spos-open'); dAdd.classList.remove('spos-busy'); dAdd.textContent = 'Add Selected Feeds';
        msg.textContent = '3 feed(s) added, 3 mapped to topic'; msg.classList.add('spos-on');
        mappedCount.textContent = '3';
        h.say('<b>Three feeds mapped</b> to the topic. Research has somewhere to look.');
      } },
      // Scene 3: to the dashboard
      { t: 31300, run: function () { h.moveCursor(h.center(navDash, 0, 0)); } },
      { t: 32400, run: h.hoverStep(navDash, 0, 0, true, 'Back to the dashboard.') },
      { t: 33200, run: h.clickStep(navDash, 0, 0, 'Back to the dashboard.') },
      { t: 33450, run: function () { navDash.classList.remove('spos-hover'); h.hideBox(); screenTopics.classList.add('spos-gone'); screenDash.classList.add('spos-shown'); h.say('The dashboard, with a new topic in the list.'); } },
      // Scene 2: the dashboard
      { t: 34500, run: function () { h.moveCursor(h.center(quickActions, 0, -30)); } },
      { t: 35600, run: h.hoverStep(topicSel, 0, 0, true, 'Pick the topic.') },
      { t: 36500, run: h.clickStep(topicSel, 0, 0, '<b>Emergency Savings Habits</b>.') },
      { t: 36750, run: function () { topicSel.classList.remove('spos-hover'); h.hideBox(); topicSel.textContent = NAME; angleSel.classList.add('spos-shown'); h.say('It has angles now, so an <b>angle picker</b> appears beneath it.'); } },
      { t: 37800, run: h.hoverStep(angleSel, 0, 0, true, 'Pick the angle.') },
      { t: 38700, run: h.clickStep(angleSel, 0, 0, '<b>Why an emergency fund starts at $500</b>.') },
      { t: 38950, run: function () {
        angleSel.classList.remove('spos-hover'); h.hideBox(); angleSel.textContent = 'Why an emergency fund starts at $500';
        monitorScope.textContent = '(topic: Emergency Savings Habits)'; monitorUsing.textContent = '4';
        feedRows.forEach(function (r, i) { if (i === 0 || i === 4) r.classList.add('spos-dim'); });
        newFeeds.forEach(function (r) { r.classList.add('spos-shown'); });
        h.say('The Research Monitor narrows to the topic: <b>three new feeds at zero</b>, catchalls kept.');
      } },
      { t: 40200, run: h.hoverStep(generate, 0, 0, true, '<b>Generate</b>. Research first, then a draft.') },
      { t: 41200, run: h.clickStep(generate, 0, 0, 'Go.') },
      { t: 41450, run: function () { generate.classList.remove('spos-hover'); h.hideBox(); genOverlay.classList.add('spos-open'); h.say('<b>Generating Content.</b> The draft saves itself as it goes.'); } },
      { t: 42800, run: function () { h.say('Research: <b>four independent sources</b>, checked against each other first.'); } },
      { t: 44300, run: function () { h.say('Drafted in the voice of the bank, from the prompt the bank keeps in its vault.'); } },
      { t: 45800, run: function () { h.say('Quality review: <b>8 of 10, pass</b>. A second, independent opinion.'); } },
      { t: 47000, run: function () { genOverlay.classList.remove('spos-open'); draftModal.scrollTop = 0; draftOverlay.classList.add('spos-open'); h.say('A draft, with its <b>sources and its scores</b> attached.'); } },
      { t: 48200, run: function () { h.moveCursor(h.center(draftModal, 60, 40)); } },
      { t: 49300, run: function () { h.say('<b>Sources Referenced</b>: four, tiered, every one behind a claim in the post.'); draftModal.scrollTop = Math.round(draftModal.scrollHeight * 0.45); } },
      { t: 51000, run: function () { h.say('<b>Quality Assessment</b>: hook, authenticity, source grounding, factual caution.'); draftModal.scrollTop = draftModal.scrollHeight; } },
      { t: 52500, run: h.hoverStep(queueBtn, 0, 0, true, '<b>Queue for Approval</b>. A person decides what happens next.') },
      { t: 54000, run: function () { queueBtn.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(START); h.say('End of recording.'); } }
    ];
    function reset() {
      screenTopics.classList.remove('spos-gone'); screenDash.classList.remove('spos-shown');
      createForm.classList.remove('spos-open'); result.classList.remove('spos-open');
      [nameIn, descIn].forEach(function (el) { el.classList.remove('spos-focus', 'spos-typed-on', 'spos-pressed'); var o = el.querySelector('.spos-tp-typed'); if (o) o.textContent = ''; });
      [addTopic, suggest, save, navDash, topicSel, angleSel, generate, queueBtn].forEach(function (el) { el.classList.remove('spos-hover', 'spos-pressed', 'spos-busy'); });
      suggest.textContent = 'Generate Suggestions';
      msg.textContent = ''; msg.classList.remove('spos-on');
      newCard.classList.remove('spos-shown', 'spos-enter');
      dOverlay.classList.remove('spos-open'); dLoading.classList.remove('spos-done'); dResults.classList.remove('spos-open'); dActions.classList.remove('spos-open');
      dSubtitle.textContent = 'Asking AI to suggest feeds, then validating each one...';
      [discoverLink, dRow1, dAdd].forEach(function (el) { el.classList.remove('spos-hover', 'spos-pressed', 'spos-busy'); });
      dAdd.textContent = 'Add Selected Feeds'; mappedCount.textContent = '0';
      newFeeds.forEach(function (r) { r.classList.remove('spos-shown'); });
      topicSel.textContent = 'Auto-select topic'; angleSel.textContent = 'Auto-select angle'; angleSel.classList.remove('spos-shown');
      monitorScope.textContent = '(all topics)'; monitorUsing.textContent = '38';
      feedRows.forEach(function (r) { r.classList.remove('spos-dim'); });
      genOverlay.classList.remove('spos-open'); draftOverlay.classList.remove('spos-open'); draftModal.scrollTop = 0;
    }
    return { script: script, duration: 55500, reset: reset, required: required, start: START,
      reducedMotion: function () { screenTopics.classList.add('spos-gone'); screenDash.classList.add('spos-shown'); draftOverlay.classList.add('spos-open'); } };
  }

  // ---------- Recording "analytics" ----------
  function buildAnalytics(h) {
    var scrA = h.q('.spos-h-screen-analytics'), scrB = h.q('.spos-h-screen-advocacy'), navAdv = h.q('.spos-h-nav-advocacy');
    var secIntel = h.q('.spos-h-sec-intel'), secAmp = h.q('.spos-h-sec-amp'), secPosts = h.q('.spos-h-sec-posts'), secTopics = h.q('.spos-h-sec-topics'), secHeat = h.q('.spos-h-sec-heat'), secDemo = h.q('.spos-h-sec-demo');
    var narBtn = h.q('.spos-h-narrative-btn'), narSec = h.q('.spos-h-narrative-section'), anMsg = h.q('.spos-h-an-msg');
    var secMe = h.q('.spos-h-sec-me'), secQueue = h.q('.spos-h-sec-queue'), secGen = h.q('.spos-h-sec-generate'), secMembers = h.q('.spos-h-sec-members');
    var queueEmpty = h.q('.spos-h-queue-empty'), variant = h.q('.spos-h-variant'), variantText = h.q('.spos-h-variant-text'), approve = h.q('.spos-h-approve');
    var sourceSel = h.q('.spos-h-source-select'), genBtn = h.q('.spos-h-generate'), genStatus = h.q('.spos-h-gen-status'), adMsg = h.q('.spos-h-ad-msg');
    var required = [scrA, scrB, navAdv, secIntel, secAmp, secPosts, secTopics, secHeat, secDemo, narBtn, narSec, anMsg,
      secMe, secQueue, secGen, secMembers, queueEmpty, variant, variantText, approve, sourceSel, genBtn, genStatus, adMsg];
    var START = { x: 300, y: 600 };
    // Scroll a page screen so `el` sits near the top of the window.
    // Smooth while playing; instant while the engine is seeking.
    function scrollTo(screen, el, offset) {
      var top = Math.max(0, el.offsetTop - (offset == null ? 16 : offset));
      var instant = !!(screen.closest && screen.closest('.spos-seeking'));
      if (screen.scrollTo) screen.scrollTo({ top: top, behavior: instant ? 'auto' : 'smooth' }); else screen.scrollTop = top;
    }
    var script = [
      // Scene 1: Analytics
      { t: 0, run: function () { h.jumpCursor(START); h.say('A sports medicine practice checks the month. <b>Analytics</b>, last 30 days.'); } },
      { t: 900, run: h.hoverStep(secIntel, 0, 0, false, 'Program Intelligence: <b>79% publish rate</b>, 14,820 connections activated by members.') },
      { t: 2800, run: function () { secIntel.classList.remove('spos-hover'); } },
      { t: 2900, run: h.hoverStep(secAmp, 0, 0, false, 'Advocacy Amplification: member reach is <b>4.6x</b> the organization page.') },
      { t: 4700, run: function () { secAmp.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secPosts); } },
      { t: 5600, run: h.hoverStep(secPosts, 0, 0, false, 'Posts: values <b>exactly as LinkedIn returned them</b>, with retrieval time.') },
      { t: 7500, run: function () { secPosts.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secTopics); } },
      { t: 8400, run: h.hoverStep(secTopics, 0, 0, false, 'Performance by Topic: <b>care-access</b> leads, 21,400 impressions across 2 posts.') },
      { t: 10300, run: function () { secTopics.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secHeat); } },
      { t: 11200, run: h.hoverStep(secHeat, 0, 0, false, 'Posting Time Heatmap: <b>weekday mornings, 7 to 9</b>, beat every other slot.') },
      { t: 13100, run: function () { secHeat.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secDemo); } },
      { t: 14000, run: h.hoverStep(secDemo, 0, 0, false, 'Follower Demographics: Hospitals and Health Care, <b>senior titles</b>, Greater Chicago.') },
      { t: 15900, run: function () { secDemo.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secIntel, 140); } },
      { t: 16900, run: function () { h.moveCursor(h.center(narBtn, 0, 0)); } },
      { t: 17800, run: h.hoverStep(narBtn, 0, 0, true, '<b>Narrative summary</b> turns the tables into a paragraph.') },
      { t: 18700, run: h.clickStep(narBtn, 0, 0, 'One request.') },
      { t: 18950, run: function () { narBtn.classList.remove('spos-hover'); h.hideBox(); narBtn.classList.add('spos-busy'); narBtn.textContent = 'Writing...'; h.say('The model writes the summary from the tables on this page only.'); } },
      { t: 20400, run: function () { narBtn.classList.remove('spos-busy'); narBtn.textContent = 'Narrative summary'; narSec.classList.add('spos-open'); h.say('Every figure is cited. <b>Uncited claims are blocked.</b>'); } },
      { t: 21300, run: h.hoverStep(narSec, 0, 0, false, 'Care access carried the month. Weekday mornings win. Members activated 14,820 connections.') },
      { t: 23800, run: function () { narSec.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secIntel, 400); } },
      { t: 24600, run: function () { h.moveCursor(h.center(navAdv, 0, 0)); } },
      { t: 25500, run: h.hoverStep(navAdv, 0, 0, true, 'Now the people who carry it further.') },
      { t: 26300, run: h.clickStep(navAdv, 0, 0, 'Now the people who carry it further.') },
      { t: 26550, run: function () { navAdv.classList.remove('spos-hover'); h.hideBox(); scrA.classList.add('spos-gone'); scrB.classList.add('spos-shown'); h.say('<b>Advocacy</b>: clinicians share the practice\'s posts from their own profiles.'); } },
      // Scene 2: Advocacy
      { t: 27600, run: h.hoverStep(secMe, 0, 0, false, 'My Participation: <b>connected</b>, manual mode, consent v3, 2,140 first-degree connections.') },
      { t: 29600, run: function () { secMe.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrB, secMembers); } },
      { t: 30500, run: h.hoverStep(secMembers, 0, 0, false, 'Members: <b>3 of 4 connected</b>, each with a voice note. Enabling never connects anyone.') },
      { t: 32700, run: function () { secMembers.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrB, secGen); } },
      { t: 33600, run: h.hoverStep(sourceSel, 0, 0, true, 'Pick the post worth amplifying.') },
      { t: 34500, run: h.clickStep(sourceSel, 0, 0, '<b>What a 20 minute wait actually costs a clinic.</b>') },
      { t: 34750, run: function () { sourceSel.classList.remove('spos-hover'); h.hideBox(); sourceSel.textContent = 'What a 20 minute wait actually costs a clinic'; } },
      { t: 35700, run: h.hoverStep(genBtn, 0, 0, true, '<b>Generate Variant Post</b>: one per connected member, in their voice.') },
      { t: 36600, run: h.clickStep(genBtn, 0, 0, 'Go.') },
      { t: 36850, run: function () { genBtn.classList.remove('spos-hover'); h.hideBox(); genBtn.classList.add('spos-busy'); genStatus.classList.add('spos-busy'); genStatus.textContent = 'Generating one variant per connected member (3)...'; h.say('One variant per connected member, in that member\'s voice.'); } },
      { t: 38300, run: function () { h.say('Each variant passes the <b>gate chain</b>: injection scan, metric fidelity, output filter, quality.'); } },
      { t: 39900, run: function () { genBtn.classList.remove('spos-busy'); genStatus.classList.remove('spos-busy'); genStatus.classList.add('spos-done'); genStatus.textContent = 'Generated 3 variant(s) across 3 member(s); each member approves their own.'; adMsg.textContent = 'Generated 3 variant(s) across 3 member(s).'; adMsg.classList.add('spos-on'); h.say('Three variants, each waiting on its member.'); } },
      { t: 41100, run: function () { scrollTo(scrB, secQueue); queueEmpty.classList.add('spos-gone'); variant.classList.add('spos-shown'); } },
      { t: 42000, run: h.hoverStep(variantText, 0, 0, false, 'Variant #31: the post rewritten in Dr. Priya Natarajan\'s own voice.') },
      { t: 42600, run: function () { variantText.classList.add('spos-focus'); } },
      { t: 44800, run: function () { variantText.classList.remove('spos-hover', 'spos-focus'); h.hideBox(); h.say('The member may edit first. <b>Nothing publishes without their approval.</b>'); } },
      { t: 46200, run: h.hoverStep(approve, 0, 0, true, '<b>Approve</b>. The member decides, not the practice.') },
      { t: 47100, run: h.clickStep(approve, 0, 0, 'Approved by the member.') },
      { t: 47350, run: function () { approve.classList.remove('spos-hover'); h.hideBox(); variant.classList.add('spos-approved'); adMsg.textContent = 'Approved. Publishing to your profile now.'; h.say('Approved. Published from the <b>member\'s own profile</b>, with their own token.'); } },
      { t: 48900, run: function () { h.say('Its reach is counted in <b>Activated Reach</b> on Analytics.'); } },
      { t: 50400, run: function () { h.moveCursor(START); h.say('End of recording.'); } }
    ];
    function reset() {
      scrA.classList.remove('spos-gone'); scrB.classList.remove('spos-shown');
      scrA.scrollTop = 0; scrB.scrollTop = 0;
      [secIntel, secAmp, secPosts, secTopics, secHeat, secDemo, narBtn, narSec, secMe, secMembers, sourceSel, genBtn, variantText, approve, navAdv].forEach(function (el) { el.classList.remove('spos-hover', 'spos-pressed', 'spos-busy', 'spos-focus'); });
      narSec.classList.remove('spos-open'); narBtn.textContent = 'Narrative summary';
      anMsg.textContent = ''; anMsg.classList.remove('spos-on'); adMsg.textContent = ''; adMsg.classList.remove('spos-on');
      sourceSel.textContent = 'Select a published post';
      genStatus.classList.remove('spos-busy', 'spos-done'); genStatus.textContent = 'No variants generated yet.';
      queueEmpty.classList.remove('spos-gone'); variant.classList.remove('spos-shown', 'spos-approved');
    }
    return { script: script, duration: 52000, reset: reset, required: required, start: START,
      reducedMotion: function () { narSec.classList.add('spos-open'); } };
  }

  // ---------- Recording "linkedin" ----------
  function buildLinkedin(h) {
    var page = h.q('.spos-l-screen-page'), consent = h.q('.spos-l-screen-consent'), allow = h.q('.spos-l-allow');
    var msg = h.q('.spos-l-msg'), secStatus = h.q('.spos-l-sec-status'), secTarget = h.q('.spos-l-sec-target'), secOrg = h.q('.spos-l-sec-org');
    var pillConn = h.q('.spos-l-pill-conn'), pillRefresh = h.q('.spos-l-pill-refresh'), pillOrg = h.q('.spos-l-pill-org');
    var personUrn = h.q('.spos-l-person-urn'), orgUrn = h.q('.spos-l-org-urn'), expAccess = h.q('.spos-l-exp-access'), expRefresh = h.q('.spos-l-exp-refresh');
    var connect = h.q('.spos-l-connect'), targetCurrent = h.q('.spos-l-target-current'), togPersonal = h.q('.spos-l-toggle-personal'), togOrg = h.q('.spos-l-toggle-org');
    var orgBody = h.q('.spos-l-org-body'), orgRow = h.q('.spos-l-org-row'), discover = h.q('.spos-l-discover');
    var required = [page, consent, allow, msg, secStatus, secTarget, secOrg, pillConn, pillRefresh, pillOrg, personUrn, orgUrn, expAccess, expRefresh,
      connect, targetCurrent, togPersonal, togOrg, orgBody, orgRow, discover];
    var START = { x: 300, y: 600 };
    function setPill(el, on, yes, no) { el.textContent = on ? yes : no; el.classList.toggle('spos-ad-pill-on', on); el.classList.toggle('spos-ad-pill-off', !on); }
    function say2(text) { msg.textContent = text; msg.classList.add('spos-on'); }
    function scrollTo(screen, el, offset) {
      var top = Math.max(0, el.offsetTop - (offset == null ? 16 : offset));
      var instant = !!(screen.closest && screen.closest('.spos-seeking'));
      if (screen.scrollTo) screen.scrollTo({ top: top, behavior: instant ? 'auto' : 'smooth' }); else screen.scrollTop = top;
    }
    var script = [
      // Scene 1: nothing connected
      { t: 0, run: function () { h.jumpCursor(START); h.say('A boutique brokerage sets up its workspace. First, <b>LinkedIn</b>.'); } },
      { t: 1000, run: h.hoverStep(secStatus, 0, 0, false, 'Nothing connected yet. Only booleans and bookmarks live here; <b>token values never leave the server</b>.') },
      { t: 3000, run: function () { secStatus.classList.remove('spos-hover'); h.hideBox(); } },
      { t: 3100, run: h.hoverStep(secTarget, 0, 0, false, 'Publish as has no setting yet, and the <b>Organization Page</b> option is locked until a page is linked.') },
      { t: 5100, run: function () { secTarget.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(h.center(connect, 0, 0)); } },
      { t: 6100, run: h.hoverStep(connect, 0, 0, true, '<b>Reconnect LinkedIn</b> runs the one OAuth grant everything else builds on.') },
      { t: 7000, run: h.clickStep(connect, 0, 0, 'Off to LinkedIn.') },
      // Scene 2: authorization
      { t: 7300, run: function () { connect.classList.remove('spos-hover'); h.hideBox(); page.classList.add('spos-gone'); consent.classList.add('spos-shown'); h.say('LinkedIn asks the broker, not the platform. The permissions are listed in plain words.'); } },
      { t: 8600, run: function () { h.moveCursor({ x: 500, y: 300 }); } },
      { t: 9700, run: function () { h.say('Posts on her behalf, the pages she manages, and their reporting. Nothing more.'); } },
      { t: 11300, run: h.hoverStep(allow, 0, 0, true, '<b>Allow</b>. She can revoke this from LinkedIn at any time.') },
      { t: 12300, run: h.clickStep(allow, 0, 0, 'Granted.') },
      // Scene 3: connected
      { t: 12550, run: function () {
        allow.classList.remove('spos-hover'); h.hideBox(); consent.classList.remove('spos-shown'); page.classList.remove('spos-gone');
        say2('LinkedIn connected. Publishing as: personal.');
        setPill(pillConn, true, 'connected', 'not connected'); setPill(pillRefresh, true, 'yes', 'no');
        personUrn.textContent = 'urn:li:person:7Xk2mQ9LpR'; expAccess.textContent = 'in 59 days'; expRefresh.textContent = 'in 364 days';
        togPersonal.classList.add('spos-ad-toggle-active'); targetCurrent.textContent = 'Current setting: new drafts will publish to the Personal profile.';
        h.say('Back on the page. <b>Connected</b>, refresh token on file, expiries bookmarked. The tokens are stored encrypted.');
      } },
      { t: 14300, run: h.hoverStep(secStatus, 0, 0, false, 'The platform refreshes the token on its own before it expires. Nobody logs in twice.') },
      { t: 16300, run: function () { secStatus.classList.remove('spos-hover'); h.hideBox(); scrollTo(page, secTarget, 120); } },
      { t: 17200, run: h.hoverStep(togPersonal, 0, 0, true, '<b>Personal profile</b> is the default. Market notes go out under her own name.') },
      { t: 19000, run: function () { togPersonal.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(h.center(discover, 0, 0)); } },
      { t: 20000, run: h.hoverStep(discover, 0, 0, true, 'Listings belong on the brokerage page. <b>Connect Org Page</b> finds the pages she administers.') },
      { t: 21100, run: h.clickStep(discover, 0, 0, 'Discovering.') },
      { t: 21350, run: function () { discover.classList.remove('spos-hover'); h.hideBox(); discover.classList.add('spos-busy'); discover.textContent = 'Discovering...'; h.say('Discovery uses the token already on file. This is linking, not another sign in.'); } },
      { t: 23000, run: function () {
        discover.classList.remove('spos-busy'); discover.textContent = 'Connect Org Page (run discovery)';
        say2('Exactly one administered organization found and connected.');
        orgBody.classList.add('spos-gone'); orgRow.classList.add('spos-shown');
        setPill(pillOrg, true, 'configured', 'not configured'); orgUrn.textContent = 'urn:li:organization:4471820';
        togOrg.classList.remove('spos-l-disabled');
        h.say('<b>Harbor Lane Realty</b> is the one page she administers. Linked, and the Organization Page option unlocks.');
      } },
      // Scene 4: switch destinations
      { t: 25000, run: function () { scrollTo(page, secTarget, 120); } },
      { t: 25900, run: h.hoverStep(togOrg, 0, 0, true, '<b>Organization Page</b>: this week the listings go out from the brokerage.') },
      { t: 26900, run: h.clickStep(togOrg, 0, 0, 'Switched.') },
      { t: 27150, run: function () {
        togOrg.classList.remove('spos-hover'); h.hideBox(); togOrg.classList.add('spos-ad-toggle-active'); togPersonal.classList.remove('spos-ad-toggle-active');
        say2('Publishing as: organization.'); targetCurrent.textContent = 'Current setting: new drafts will publish to the Organization Page.';
        h.say('New drafts are stamped for the page. Drafts already written keep the destination they were born with.');
      } },
      { t: 29200, run: h.hoverStep(togPersonal, 0, 0, true, 'Next week, a market note in her own voice. <b>Personal profile</b> again.') },
      { t: 30300, run: h.clickStep(togPersonal, 0, 0, 'Switched back.') },
      { t: 30550, run: function () {
        togPersonal.classList.remove('spos-hover'); h.hideBox(); togPersonal.classList.add('spos-ad-toggle-active'); togOrg.classList.remove('spos-ad-toggle-active');
        say2('Publishing as: personal.'); targetCurrent.textContent = 'Current setting: new drafts will publish to the Personal profile.';
        h.say('One grant, two destinations, chosen per draft. Page posts feed analytics; profile posts stay hers.');
      } },
      { t: 32600, run: function () { h.moveCursor(START); h.say('End of recording.'); } }
    ];
    function reset() {
      page.classList.remove('spos-gone'); consent.classList.remove('spos-shown'); page.scrollTop = 0;
      [secStatus, secTarget, secOrg, connect, allow, togPersonal, togOrg, discover].forEach(function (el) { el.classList.remove('spos-hover', 'spos-pressed', 'spos-busy'); });
      msg.textContent = ''; msg.classList.remove('spos-on');
      setPill(pillConn, false, 'connected', 'not connected'); setPill(pillRefresh, false, 'yes', 'no'); setPill(pillOrg, false, 'configured', 'not configured');
      personUrn.textContent = 'not stored'; orgUrn.textContent = 'not stored'; expAccess.textContent = 'not stored'; expRefresh.textContent = 'not stored';
      targetCurrent.textContent = 'Current setting: not chosen yet; new drafts cannot resolve a destination until one is selected.';
      togPersonal.classList.remove('spos-ad-toggle-active'); togOrg.classList.remove('spos-ad-toggle-active'); togOrg.classList.add('spos-l-disabled');
      orgBody.classList.remove('spos-gone'); orgRow.classList.remove('spos-shown');
      discover.textContent = 'Connect Org Page (run discovery)';
    }
    return { script: script, duration: 34000, reset: reset, required: required, start: START,
      reducedMotion: function () { setPill(pillConn, true, 'connected', 'not connected'); togPersonal.classList.add('spos-ad-toggle-active'); } };
  }

  // ---------- Recording "imagestudio" ----------
  function buildImageStudio(h) {
    var dash = h.q('.spos-i-screen-dash'), feed = h.q('.spos-i-screen-feed');
    var card = h.q('.spos-i-card'), cardStatus = h.q('.spos-i-status'), cardActions = h.q('.spos-i-actions'), thumb = h.q('.spos-i-thumb'), editBtn = h.q('.spos-i-edit-btn');
    var queueBadge = h.q('.spos-i-queue-badge'), statPending = h.q('.spos-i-stat-pending'), statPublished = h.q('.spos-i-stat-published');
    var editOverlay = h.q('.spos-i-edit-overlay'), editModal = h.q('.spos-i-edit-modal'), panel = h.q('.spos-i-panel'), lens = h.q('.spos-i-lens'), prompt = h.q('.spos-i-prompt');
    var generate = h.q('.spos-i-generate'), attach = h.q('.spos-i-attach'), attached = h.q('.spos-i-attached'), preview = h.q('.spos-i-preview'), save = h.q('.spos-i-save');
    var detailOverlay = h.q('.spos-i-detail-overlay'), detailModal = h.q('.spos-i-detail-modal'), publish = h.q('.spos-i-publish');
    var feedActions = h.q('.spos-li-feed-actions');
    var required = [dash, feed, card, cardStatus, cardActions, thumb, editBtn, queueBadge, statPending, statPublished, editOverlay, editModal, panel, lens, prompt,
      generate, attach, attached, preview, save, detailOverlay, detailModal, publish, feedActions];
    var START = { x: 300, y: 600 };
    var PROMPT = 'Late September at the nursery, first light on rows of mums, one customer choosing hers';
    var script = [
      // Scene 1: the post waiting for approval
      { t: 0, run: function () { h.jumpCursor(START); h.say('A garden center, mid September. One post is waiting, and it has no picture.'); } },
      { t: 900, run: function () { h.moveCursor(h.center(card, -40, 0)); } },
      { t: 2000, run: h.hoverStep(editBtn, 0, 0, true, '<b>Fall is the second spring</b>: the words are ready. Edit it before it goes out.') },
      { t: 3200, run: h.clickStep(editBtn, 0, 0, 'Open it up.') },
      { t: 3450, run: function () { editBtn.classList.remove('spos-hover'); h.hideBox(); editModal.scrollTop = 0; editOverlay.classList.add('spos-open'); h.say('Title, body, hashtags. Below them, <b>Generate with AI</b>: Image Studio inside the post.'); } },
      { t: 4700, run: function () { h.moveCursor(h.center(editModal, 60, 40)); editModal.scrollTop = editModal.scrollHeight; } },
      // Scene 2: Image Studio
      { t: 5900, run: h.hoverStep(lens, 0, 0, true, '<b>Story Lens: Editorial Photo.</b> The picture follows the story, not the other way round.') },
      { t: 7600, run: function () { lens.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(h.center(prompt, -80, 0), true); } },
      { t: 8300, run: h.clickStep(prompt, -80, 0, 'Describe the picture in a sentence.') },
      { t: 8500, run: h.typeStep(prompt, PROMPT, 40) },
      { t: 12300, run: function () { prompt.classList.remove('spos-focus'); h.moveCursor(h.center(generate, 0, 0), true); } },
      { t: 13100, run: h.hoverStep(generate, 0, 0, true, '<b>Generate.</b> The spend estimate is checked against the image budget first.') },
      { t: 14100, run: h.clickStep(generate, 0, 0, 'Go.') },
      { t: 14350, run: function () { generate.classList.remove('spos-hover'); h.hideBox(); generate.classList.add('spos-busy'); generate.textContent = 'Working...'; preview.classList.add('spos-shown'); editModal.scrollTop = editModal.scrollHeight; h.say('Budget cleared. <b>Rendering</b> with the workspace image model.'); } },
      { t: 16000, run: function () { h.say('Every figure the brief carries is checked against the post. No invented numbers in the picture.'); } },
      { t: 17800, run: function () { preview.classList.add('spos-ready'); generate.classList.remove('spos-busy'); generate.textContent = 'Regenerate'; attach.classList.add('spos-shown'); editModal.scrollTop = editModal.scrollHeight; h.say('<b>Rendered.</b> Metadata stripped, stored in the library, charged to the ledger once.'); } },
      { t: 19600, run: h.hoverStep(attach, 0, 0, true, '<b>Attach to Post.</b> The picture is stamped to this post.') },
      { t: 20600, run: h.clickStep(attach, 0, 0, 'Attached.') },
      { t: 20850, run: function () { attach.classList.remove('spos-hover', 'spos-shown'); h.hideBox(); attached.classList.add('spos-shown'); h.say('<b>AI image attached.</b> Detach is one click away if the words change.'); } },
      { t: 22200, run: h.hoverStep(save, 0, 0, true, '<b>Save Changes.</b> Still a post waiting for approval, now with its picture.') },
      { t: 23200, run: h.clickStep(save, 0, 0, 'Saved.') },
      { t: 23450, run: function () { save.classList.remove('spos-hover'); h.hideBox(); editOverlay.classList.remove('spos-open'); thumb.classList.add('spos-shown'); h.say('The queue card shows the thumbnail. Now the decision.'); } },
      // Scene 3: publish
      { t: 24700, run: h.hoverStep(card, -60, -6, false, 'Open the post to review everything it will publish with.') },
      { t: 26000, run: h.clickStep(card, -60, -6, 'The whole story.') },
      { t: 26250, run: function () { card.classList.remove('spos-hover'); h.hideBox(); detailModal.scrollTop = 0; detailOverlay.classList.add('spos-open'); h.say('Three sources, strong corroboration, and the picture chosen under <b>Post Image</b>.'); } },
      { t: 27400, run: function () { h.moveCursor(h.center(detailModal, 80, 20)); } },
      { t: 28400, run: function () { h.say('The image is validated again before LinkedIn sees it: type, size, and a clean upload.'); detailModal.scrollTop = detailModal.scrollHeight; } },
      { t: 29600, run: h.hoverStep(publish, 0, 0, true, '<b>Publish</b> to the garden center page. Once, and only when a person says so.') },
      { t: 30800, run: h.clickStep(publish, 0, 0, 'Approved by a person. Published by the platform.') },
      { t: 31050, run: function () { publish.classList.remove('spos-hover'); h.hideBox(); detailOverlay.classList.remove('spos-open'); h.say('Image uploaded first, post created with it, LinkedIn id stamped.'); } },
      { t: 31600, run: function () { cardStatus.textContent = 'posted'; cardStatus.classList.add('spos-status-posted'); cardActions.style.visibility = 'hidden'; card.classList.add('spos-published'); queueBadge.textContent = '0'; statPending.textContent = '0'; statPublished.textContent = '42'; h.say('From pending to posted. <b>Forty two published.</b>'); } },
      // Scene 4: live in the feed
      { t: 33000, run: function () { dash.classList.add('spos-gone'); feed.classList.add('spos-shown'); h.say('And this is what the followers see: the words, the picture, the page.'); } },
      { t: 34200, run: function () { h.moveCursor({ x: 500, y: 420 }); } },
      { t: 35400, run: h.hoverStep(feedActions, 0, 0, false, 'Live on the <b>Meadowbrook Garden Center</b> page, with the picture made three minutes ago.') },
      { t: 37400, run: function () { feedActions.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(START); h.say('End of recording.'); } }
    ];
    function reset() {
      dash.classList.remove('spos-gone'); feed.classList.remove('spos-shown');
      editOverlay.classList.remove('spos-open'); detailOverlay.classList.remove('spos-open'); editModal.scrollTop = 0; detailModal.scrollTop = 0;
      [card, editBtn, lens, prompt, generate, attach, save, publish, feedActions].forEach(function (el) { el.classList.remove('spos-hover', 'spos-pressed', 'spos-focus', 'spos-busy', 'spos-typed-on'); });
      var typed = prompt.querySelector('.spos-tp-typed'); if (typed) typed.textContent = '';
      generate.textContent = 'Generate'; attach.classList.remove('spos-shown'); attached.classList.remove('spos-shown');
      preview.classList.remove('spos-shown', 'spos-ready'); thumb.classList.remove('spos-shown');
      cardStatus.textContent = 'pending approval'; cardStatus.classList.remove('spos-status-posted'); cardActions.style.visibility = ''; card.classList.remove('spos-published');
      queueBadge.textContent = '1'; statPending.textContent = '1'; statPublished.textContent = '41';
    }
    return { script: script, duration: 38500, reset: reset, required: required, start: START,
      reducedMotion: function () { editOverlay.classList.add('spos-open'); preview.classList.add('spos-shown', 'spos-ready'); attached.classList.add('spos-shown'); } };
  }

  // ---------- Controller ----------
  var builders = { create: buildCreate, topics: buildTopics, analytics: buildAnalytics, linkedin: buildLinkedin, imagestudio: buildImageStudio };
  var recordings = {};
  Array.prototype.slice.call(root.querySelectorAll('.spos-recording[data-recording]')).forEach(function (el) {
    var name = el.getAttribute('data-recording');
    var rec = builders[name] ? makeRecording(el, builders[name]) : null;
    if (rec) recordings[name] = rec;
  });
  tabs.forEach(function (tab) { if (!recordings[tab.getAttribute('data-recording')]) tab.disabled = true; });

  var active = null;
  function show(name) {
    if (!recordings[name] || name === active) return;
    if (active && recordings[active]) recordings[active].stop();
    active = name;
    Array.prototype.slice.call(root.querySelectorAll('.spos-recording[data-recording]')).forEach(function (el) { el.classList.toggle('spos-active', el.getAttribute('data-recording') === name); });
    tabs.forEach(function (t) { var on = t.getAttribute('data-recording') === name; t.classList.toggle('spos-active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    syncControls();
    // Let the display toggle above get its own layout pass; start on the
    // next frame so nothing in start() forces a synchronous reflow.
    var pending = name;
    window.requestAnimationFrame(function () {
      if (active !== pending || !recordings[pending]) return;
      recordings[pending].start();
      syncControls();
    });
  }
  tabs.forEach(function (tab) { tab.addEventListener('click', function () { show(tab.getAttribute('data-recording')); }); });

  // Player bar below the window.
  var seekEl = root.querySelector('.spos-seek'), seekFill = root.querySelector('.spos-seek-fill'), seekKnob = root.querySelector('.spos-seek-knob');
  var timeCur = root.querySelector('.spos-time-cur'), timeDur = root.querySelector('.spos-time-dur');
  function fmt(scaledMs) {
    var sec = Math.max(0, Math.round(scaledMs / PLAYBACK_RATE / 1000));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function syncControls() {
    var rec = active ? recordings[active] : null;
    var disabled = !rec || reducedMotion;
    if (playBtn) {
      playBtn.disabled = disabled;
      var playing = rec ? rec.isPlaying() : false;
      playBtn.classList.toggle('spos-playing', playing);
      playBtn.setAttribute('aria-label', playing ? 'Pause the recording' : 'Play the recording');
    }
    if (restartBtn) restartBtn.disabled = disabled;
    if (seekEl) seekEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
  function paintProgress() {
    var rec = active ? recordings[active] : null;
    if (!rec || !seekFill) return;
    var p = rec.progress(), frac = p.duration ? p.elapsed / p.duration : 0;
    seekFill.style.width = (frac * 100) + '%';
    if (seekKnob) seekKnob.style.left = (frac * 100) + '%';
    if (seekEl) seekEl.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    if (timeCur) timeCur.textContent = fmt(p.elapsed);
    if (timeDur) timeDur.textContent = fmt(p.duration);
  }
  (function progressLoop() { paintProgress(); window.requestAnimationFrame(progressLoop); })();
  function seekToFraction(frac) {
    var rec = active ? recordings[active] : null;
    if (!rec || reducedMotion) return;
    var p = rec.progress();
    rec.seek(Math.max(0, Math.min(1, frac)) * p.duration);
    paintProgress(); syncControls();
  }
  if (playBtn) playBtn.addEventListener('click', function () { var rec = recordings[active]; if (!rec) return; if (rec.isPlaying()) rec.pause(); else rec.play(); syncControls(); });
  if (restartBtn) restartBtn.addEventListener('click', function () { var rec = recordings[active]; if (!rec) return; rec.restart(); syncControls(); });
  if (seekEl) {
    seekEl.addEventListener('click', function (e) { var r = seekEl.getBoundingClientRect(); if (r.width) seekToFraction((e.clientX - r.left) / r.width); });
    seekEl.addEventListener('keydown', function (e) {
      var rec = active ? recordings[active] : null; if (!rec) return;
      var p = rec.progress(), frac = p.duration ? p.elapsed / p.duration : 0, step = 0.05;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { seekToFraction(frac + step); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { seekToFraction(frac - step); e.preventDefault(); }
      else if (e.key === 'Home') { seekToFraction(0); e.preventDefault(); }
      else if (e.key === 'End') { seekToFraction(1); e.preventDefault(); }
      else if (e.key === ' ' || e.key === 'Enter') { if (rec.isPlaying()) rec.pause(); else rec.play(); syncControls(); e.preventDefault(); }
    });
  }
  Object.keys(recordings).forEach(function (k) { recordings[k].onStateChange(syncControls); });
  onFrameResize = function () { if (active && recordings[active]) recordings[active].fit(); };
  if (!window.ResizeObserver) window.addEventListener('resize', function () { frameWidth = 0; onFrameResize(); });

  var first = (tabs.filter(function (t) { return t.classList.contains('spos-active') && !t.disabled; })[0] || tabs.filter(function (t) { return !t.disabled; })[0]);
  var firstName = first ? first.getAttribute('data-recording') : Object.keys(recordings)[0];
  if (!firstName) return;

  // Wait for web fonts so element geometry is final before the first measurement.
  var begin = function () { setTimeout(function () { show(firstName); }, 250); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(begin); else begin();
})();
