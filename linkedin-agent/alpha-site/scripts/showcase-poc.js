// ================================================================
// showcase-poc.js  (delivery 3.3.23)
// ================================================================
// Drives the showcase replays at the top of the marketing homepage
// (site_templates/index.html, #showcase-pos). Three recordings live in
// one window; a tab row picks which one plays. Only the active
// recording runs; switching stops the other, resets it, and starts
// the chosen one from its first frame.
//
//   "create"  1. Create: hover and click the Create CTA, the Create a
//                post modal opens, a genre is hovered, the modal closes.
//             2. Edit: click Edit on the pending queue card, the Edit
//                Post modal opens, the Content field takes focus, Save
//                Changes is clicked.
//             3. Publish: click the pending card, the post detail modal
//                opens, it scrolls to the actions, Publish is clicked,
//                the queue and the stat cards reflect it.
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
//   selectors or API paths appear in the window bar.
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
  var footnotes = Array.prototype.slice.call(root.querySelectorAll('.spos-footnote[data-recording]'));
  if (!frame || !callout) return;

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.style.setProperty('--spos-rate', String(PLAYBACK_RATE));

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
      var s = Math.min(1, frame.clientWidth / STAGE_W);
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
      cursor.classList.add('spos-jump');
      cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
      void cursor.offsetWidth;
      cursor.classList.remove('spos-jump');
    }
    function clickAt(p) {
      ripple.style.left = p.x + 'px'; ripple.style.top = p.y + 'px';
      ripple.classList.remove('spos-go'); void ripple.offsetWidth; ripple.classList.add('spos-go');
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
      void stage.offsetWidth;
      stage.classList.remove('spos-seeking');
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
    var composer = h.q('.spos-composer-overlay'), composerClose = h.q('.spos-composer-close'), btnCreate = h.q('.spos-btn-create'), quickActions = h.q('.spos-quick-actions');
    var genreNone = h.q('.spos-genre-none'), genreInsight = h.q('.spos-genre-insight');
    var pendingCard = h.q('.spos-pending-card'), editBtn = h.q('.spos-edit-btn');
    var editOverlay = h.q('.spos-edit-overlay'), editTextarea = h.q('.spos-edit-textarea'), editSave = h.q('.spos-edit-save');
    var detailOverlay = h.q('.spos-detail-overlay'), detailModal = h.q('.spos-detail-modal'), publishBtn = h.q('.spos-publish-btn');
    var pendingStatus = h.q('.spos-pending-status'), pendingActions = h.q('.spos-pending-actions'), queueBadge = h.q('.spos-queue-badge');
    var statPublished = h.q('.spos-stat-published'), statPending = h.q('.spos-stat-pending');
    var required = [composer, composerClose, btnCreate, quickActions, genreNone, genreInsight, pendingCard, editBtn, editOverlay, editTextarea, editSave,
      detailOverlay, detailModal, publishBtn, pendingStatus, pendingActions, queueBadge, statPublished, statPending];
    var START = { x: 300, y: 600 };
    var script = [
      { t: 0, run: function () { h.jumpCursor(START); } },
      { t: 900, run: function () { h.moveCursor(h.center(quickActions, 0, -40)); } },
      { t: 2000, run: h.hoverStep(btnCreate, 4, 2, true, 'Monday at the shop. One post is waiting, and a new idea is forming. <b>Create</b> opens a blank page.') },
      { t: 3400, run: h.clickStep(btnCreate, 4, 2, 'One click.') },
      { t: 3650, run: function () { btnCreate.classList.remove('spos-hover'); h.hideBox(); composer.classList.add('spos-open'); h.say('Pick a genre first. <b>no genre</b> is a clean canvas; the others carry the house style of the store.'); } },
      { t: 4600, run: function () { h.moveCursor(h.center(genreNone, -160, 0)); } },
      { t: 5700, run: h.hoverStep(genreInsight, -180, 0, true, '<b>insight</b> turns one shopper trend into a point of view, grounded in current research.') },
      { t: 7200, run: function () { genreInsight.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(h.center(composerClose, 0, 0)); } },
      { t: 8300, run: h.clickStep(composerClose, 0, 0, 'Not today. The post already in the queue comes first.') },
      { t: 8500, run: function () { composer.classList.remove('spos-open'); h.say('Back to the queue.'); } },
      { t: 9500, run: function () { h.moveCursor(h.center(pendingCard, -40, 0)); } },
      { t: 10700, run: h.hoverStep(editBtn, 0, 0, true, '<b>Points are not loyalty</b>, drafted this morning from two shopper studies, waits for a decision.') },
      { t: 12000, run: h.clickStep(editBtn, 0, 0, 'Edit before it goes anywhere.') },
      { t: 12250, run: function () { editBtn.classList.remove('spos-hover'); h.hideBox(); editOverlay.classList.add('spos-open'); h.say('Title, body, hashtags, and a picture if the story needs one. <b>Nothing publishes on its own.</b>'); } },
      { t: 13300, run: function () { h.moveCursor(h.center(editTextarea, 120, 40)); } },
      { t: 14400, run: h.clickStep(editTextarea, 120, 40, 'A word here, a line there. The draft stays a draft while it is being shaped.') },
      { t: 14600, run: function () { editTextarea.classList.add('spos-focus'); } },
      { t: 16200, run: function () { editTextarea.classList.remove('spos-focus'); h.moveCursor(h.center(editSave, 0, 0)); } },
      { t: 17300, run: h.hoverStep(editSave, 0, 0, true, '<b>Save Changes</b> keeps it in the queue, edited, still waiting for a person.') },
      { t: 18300, run: h.clickStep(editSave, 0, 0, 'Saved.') },
      { t: 18550, run: function () { editSave.classList.remove('spos-hover'); h.hideBox(); editOverlay.classList.remove('spos-open'); h.say('The edit is in. Now the decision.'); } },
      { t: 19600, run: h.hoverStep(pendingCard, -60, -6, false, 'Open the post itself to see what it was built from.') },
      { t: 21000, run: h.clickStep(pendingCard, -60, -6, 'The whole story, with its receipts.') },
      { t: 21250, run: function () { pendingCard.classList.remove('spos-hover'); h.hideBox(); detailModal.scrollTop = 0; detailOverlay.classList.add('spos-open'); h.say('<b>Strong corroboration</b>: four sources agreed before a word was written.'); } },
      { t: 22400, run: function () { h.moveCursor(h.center(detailModal, 80, 20)); } },
      { t: 23500, run: function () { h.say('Sources listed. Image chosen. Everything a reviewer needs is on one screen.'); detailModal.scrollTop = detailModal.scrollHeight; } },
      { t: 24500, run: h.hoverStep(publishBtn, 0, 0, true, '<b>Publish</b> sends it to the organization page. Once, and only after a person says so.') },
      { t: 25800, run: h.clickStep(publishBtn, 0, 0, 'Approved by a person. Published by the platform.') },
      { t: 26050, run: function () { publishBtn.classList.remove('spos-hover'); h.hideBox(); detailOverlay.classList.remove('spos-open'); h.say('From pending to posted.'); } },
      { t: 26600, run: function () {
        pendingStatus.textContent = 'posted'; pendingStatus.classList.add('spos-status-posted');
        pendingActions.style.visibility = 'hidden'; pendingCard.classList.add('spos-published');
        queueBadge.textContent = '0'; statPending.textContent = '0'; statPublished.textContent = '28';
        h.say('<b>Twenty eight published.</b> Queue empty. Back to the floor.');
      } },
      { t: 27800, run: function () { h.moveCursor(START); } },
      { t: 28600, run: function () { h.say('End of recording.'); } }
    ];
    function reset() {
      composer.classList.remove('spos-open'); editOverlay.classList.remove('spos-open'); detailOverlay.classList.remove('spos-open');
      var touched = [btnCreate, genreInsight, editBtn, editSave, pendingCard, publishBtn, composerClose, editTextarea];
      for (var i = 0; i < touched.length; i++) { touched[i].classList.remove('spos-hover', 'spos-pressed', 'spos-focus'); }
      detailModal.scrollTop = 0;
      pendingStatus.textContent = 'pending approval'; pendingStatus.classList.remove('spos-status-posted');
      pendingActions.style.visibility = ''; pendingCard.classList.remove('spos-published');
      queueBadge.textContent = '1'; statPending.textContent = '1'; statPublished.textContent = '27';
    }
    return { script: script, duration: 29500, reset: reset, required: required, start: START,
      reducedMotion: function () { composer.classList.add('spos-open'); } };
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
      { t: 10600, run: h.hoverStep(suggest, 0, 0, true, '<b>Generate Suggestions</b> asks the model for angles and hashtags that fit the description.') },
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
      { t: 19300, run: h.hoverStep(discoverLink, 0, 0, true, '<b>Discover Feeds</b>: let the model find sources for this topic instead of hunting for them by hand.') },
      { t: 20200, run: h.clickStep(discoverLink, 0, 0, 'Searching.') },
      { t: 20450, run: function () { discoverLink.classList.remove('spos-hover'); h.hideBox(); dOverlay.classList.add('spos-open'); h.say('The model proposes candidate feeds.'); } },
      { t: 21700, run: function () { h.say('Then the platform checks its work.'); } },
      { t: 23000, run: function () { h.say('Each candidate is <b>fetched, parsed and graded</b> before it is offered. Broken feeds never reach the list.'); } },
      { t: 24400, run: function () { dLoading.classList.add('spos-done'); dResults.classList.add('spos-open'); dActions.classList.add('spos-open'); dSubtitle.textContent = '3 validated feeds found'; h.say('<b>Three validated feeds</b>, all selected, each with a reason and a recent headline.'); } },
      { t: 25500, run: h.hoverStep(dRow1, 0, 0, true, '<b>Savings Habit Lab</b>: primary tier, strongest on automatic transfers and small first balances.') },
      { t: 27000, run: function () { dRow1.classList.remove('spos-hover'); h.hideBox(); h.moveCursor(h.center(dAdd, 0, 0)); } },
      { t: 28000, run: h.hoverStep(dAdd, 0, 0, true, '<b>Add Selected Feeds</b>.') },
      { t: 28900, run: h.clickStep(dAdd, 0, 0, 'Adding.') },
      { t: 29150, run: function () { dAdd.classList.remove('spos-hover'); h.hideBox(); dAdd.classList.add('spos-busy'); dAdd.textContent = 'Adding...'; } },
      { t: 30300, run: function () {
        dOverlay.classList.remove('spos-open'); dAdd.classList.remove('spos-busy'); dAdd.textContent = 'Add Selected Feeds';
        msg.textContent = '3 feed(s) added, 3 mapped to topic'; msg.classList.add('spos-on');
        mappedCount.textContent = '3';
        h.say('<b>Three feeds mapped</b> to the topic. The card says so. Research has somewhere to look.');
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
        h.say('The Research Monitor narrows to the topic: <b>three new feeds at zero</b>, waiting for their first poll, catchalls kept.');
      } },
      { t: 40200, run: h.hoverStep(generate, 0, 0, true, '<b>Generate</b>. Research first, then a draft.') },
      { t: 41200, run: h.clickStep(generate, 0, 0, 'Go.') },
      { t: 41450, run: function () { generate.classList.remove('spos-hover'); h.hideBox(); genOverlay.classList.add('spos-open'); h.say('<b>Generating Content.</b> The draft saves itself as it goes.'); } },
      { t: 42800, run: function () { h.say('Research: <b>four independent sources</b>, checked against each other before anything is written.'); } },
      { t: 44300, run: function () { h.say('The draft is written in the voice of the bank, from the prompt the bank keeps in its vault.'); } },
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
      { t: 0, run: function () { h.jumpCursor(START); h.say('pageview <b>/app/analytics/</b> (window: last 30 days)'); } },
      { t: 900, run: h.hoverStep(secIntel, 0, 0, false, 'Advocacy Program Intelligence: <b>79% publish rate</b>, 14,820 connections activated by members') },
      { t: 2800, run: function () { secIntel.classList.remove('spos-hover'); } },
      { t: 2900, run: h.hoverStep(secAmp, 0, 0, false, 'Advocacy Amplification: member reach is <b>4.6x</b> the organization page') },
      { t: 4700, run: function () { secAmp.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secPosts); } },
      { t: 5600, run: h.hoverStep(secPosts, 0, 0, false, 'Posts: values <b>exactly as LinkedIn returned them</b>, with retrieval time') },
      { t: 7500, run: function () { secPosts.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secTopics); } },
      { t: 8400, run: h.hoverStep(secTopics, 0, 0, false, 'Performance by Topic: <b>care-access</b> leads, 21,400 impressions across 2 posts') },
      { t: 10300, run: function () { secTopics.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secHeat); } },
      { t: 11200, run: h.hoverStep(secHeat, 0, 0, false, 'Posting Time Heatmap: <b>weekday mornings, 7 to 9</b>, outperform every other slot') },
      { t: 13100, run: function () { secHeat.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secDemo); } },
      { t: 14000, run: h.hoverStep(secDemo, 0, 0, false, 'Follower Demographics: Hospitals and Health Care, <b>senior titles</b>, Greater Chicago') },
      { t: 15900, run: function () { secDemo.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secIntel, 140); } },
      { t: 16900, run: function () { h.moveCursor(h.center(narBtn, 0, 0)); } },
      { t: 17800, run: h.hoverStep(narBtn, 0, 0, true, 'hover <b>button#btn-narrative</b> "Narrative summary"') },
      { t: 18700, run: h.clickStep(narBtn, 0, 0, 'click <b>button#btn-narrative</b> (POST /api/analytics/narrative)') },
      { t: 18950, run: function () { narBtn.classList.remove('spos-hover'); h.hideBox(); narBtn.classList.add('spos-busy'); narBtn.textContent = 'Writing...'; h.say('model writes the summary from the tables on this page only'); } },
      { t: 20400, run: function () { narBtn.classList.remove('spos-busy'); narBtn.textContent = 'Narrative summary'; narSec.classList.add('spos-open'); h.say('render <b>#narrative-section</b>: every figure cited, <b>uncited claims blocked</b>'); } },
      { t: 21300, run: h.hoverStep(narSec, 0, 0, false, 'narrative: care access carried the month, weekday mornings win, member posts activated 14,820 connections') },
      { t: 23800, run: function () { narSec.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrA, secIntel, 400); } },
      { t: 24600, run: function () { h.moveCursor(h.center(navAdv, 0, 0)); } },
      { t: 25500, run: h.hoverStep(navAdv, 0, 0, true, 'hover <b>a.manager-nav-link</b> "Advocacy"') },
      { t: 26300, run: h.clickStep(navAdv, 0, 0, 'click <b>a.manager-nav-link</b> "Advocacy"') },
      { t: 26550, run: function () { navAdv.classList.remove('spos-hover'); h.hideBox(); scrA.classList.add('spos-gone'); scrB.classList.add('spos-shown'); h.say('pageview <b>/app/advocacy/</b> (entitlement: employee_advocacy)'); } },
      // Scene 2: Advocacy
      { t: 27600, run: h.hoverStep(secMe, 0, 0, false, 'My Participation: <b>connected</b>, manual mode, consent version 3, 2,140 first-degree connections') },
      { t: 29600, run: function () { secMe.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrB, secMembers); } },
      { t: 30500, run: h.hoverStep(secMembers, 0, 0, false, 'Members: <b>3 of 4 connected</b>, each with a voice note; enabling never connects anyone, members consent themselves') },
      { t: 32700, run: function () { secMembers.classList.remove('spos-hover'); h.hideBox(); scrollTo(scrB, secGen); } },
      { t: 33600, run: h.hoverStep(sourceSel, 0, 0, true, 'hover <b>select#gen-post-id</b> "Source post"') },
      { t: 34500, run: h.clickStep(sourceSel, 0, 0, 'select source post <b>"What a 20 minute wait actually costs a clinic"</b>') },
      { t: 34750, run: function () { sourceSel.classList.remove('spos-hover'); h.hideBox(); sourceSel.textContent = 'What a 20 minute wait actually costs a clinic'; } },
      { t: 35700, run: h.hoverStep(genBtn, 0, 0, true, 'hover <b>button#btn-generate</b> "Generate Variant Post"') },
      { t: 36600, run: h.clickStep(genBtn, 0, 0, 'click <b>button#btn-generate</b> (POST /api/advocacy/generate)') },
      { t: 36850, run: function () { genBtn.classList.remove('spos-hover'); h.hideBox(); genBtn.classList.add('spos-busy'); genStatus.classList.add('spos-busy'); genStatus.textContent = 'Generating one variant per connected member (3)...'; h.say('one variant per connected member, in that member\'s voice'); } },
      { t: 38300, run: function () { h.say('each variant passes the <b>gate chain</b>: injection scan, metric fidelity, output filter, quality'); } },
      { t: 39900, run: function () { genBtn.classList.remove('spos-busy'); genStatus.classList.remove('spos-busy'); genStatus.classList.add('spos-done'); genStatus.textContent = 'Generated 3 variant(s) across 3 member(s); each member approves their own.'; adMsg.textContent = 'Generated 3 variant(s) across 3 member(s).'; adMsg.classList.add('spos-on'); h.say('3 <b>advocacy_variants</b> rows, status pending_approval'); } },
      { t: 41100, run: function () { scrollTo(scrB, secQueue); queueEmpty.classList.add('spos-gone'); variant.classList.add('spos-shown'); } },
      { t: 42000, run: h.hoverStep(variantText, 0, 0, false, 'render <b>.variant-card</b> Variant #31: the post rewritten in Dr. Priya Natarajan\'s voice') },
      { t: 42600, run: function () { variantText.classList.add('spos-focus'); } },
      { t: 44800, run: function () { variantText.classList.remove('spos-hover', 'spos-focus'); h.hideBox(); h.say('the member may edit before approving; <b>nothing publishes without their approval</b>'); } },
      { t: 46200, run: h.hoverStep(approve, 0, 0, true, 'hover <b>button.btn-primary</b> "Approve"') },
      { t: 47100, run: h.clickStep(approve, 0, 0, 'click <b>button.btn-primary</b> "Approve" (POST /api/advocacy/me/variants/31/approve)') },
      { t: 47350, run: function () { approve.classList.remove('spos-hover'); h.hideBox(); variant.classList.add('spos-approved'); adMsg.textContent = 'Approved. Publishing to your profile now.'; h.say('approved: published from the <b>member\'s own profile</b> with the member\'s own token'); } },
      { t: 48900, run: function () { h.say('reach from this post is counted in <b>Activated Reach</b> on Analytics'); } },
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

  // ---------- Controller ----------
  var builders = { create: buildCreate, topics: buildTopics, analytics: buildAnalytics };
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
    footnotes.forEach(function (f) { f.hidden = f.getAttribute('data-recording') !== name; });
    recordings[name].start();
    syncControls();
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
  window.addEventListener('resize', function () { if (active && recordings[active]) recordings[active].fit(); });

  var first = (tabs.filter(function (t) { return t.classList.contains('spos-active') && !t.disabled; })[0] || tabs.filter(function (t) { return !t.disabled; })[0]);
  var firstName = first ? first.getAttribute('data-recording') : Object.keys(recordings)[0];
  if (!firstName) return;

  // Wait for web fonts so element geometry is final before the first measurement.
  var begin = function () { setTimeout(function () { show(firstName); }, 250); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(begin); else begin();
})();
