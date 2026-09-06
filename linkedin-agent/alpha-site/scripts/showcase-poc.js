// ================================================================
// showcase-poc.js  (delivery 3.3.13)
// ================================================================
// Drives the showcase replay at the top of the marketing homepage
// (site_templates/index.html, #showcase-pos). Three scenes:
//   1. Create: hover and click the Create CTA, the Create a post modal
//      opens, a genre is hovered, the modal is closed.
//   2. Edit: click Edit on the pending queue card, the Edit Post modal
//      opens, the Content field takes focus, Save Changes is clicked.
//   3. Publish: click the pending card, the post detail modal opens,
//      it scrolls to the actions, Publish is clicked, the queue and the
//      stat cards reflect the published post.
//
// Behavior
//   - Plays automatically at PLAYBACK_RATE (0.4x): the twenty two
//     second recording takes fifty five seconds of wall time.
//   - Holds for END_PAUSE_MS (3000) on the final frame, resets to the
//     first frame, and repeats forever. There are no controls.
//   - Cursor travel, click ripple and the modal fade are scaled by the
//     same rate through the --spos-rate custom property that
//     showcase-poc.css reads, so the whole scene slows together.
//
// Constraints honored
//   - Page CSP is script-src 'self' and style-src 'self'. This file
//     is loaded by src, never inlined. Geometry is written through the
//     CSSOM (element.style.left), never through a style attribute.
//   - Nothing here reads user input or network data. Caption text is
//     a fixed table in this file, so innerHTML carries only literals.
//     The caption element sits in the .shot-window-bar, right of the
//     three dots, and is found by its .spos-callout class.
//   - Fully idempotent: if #showcase-pos is absent, or any element the
//     script drives is missing, the script returns without touching
//     the page.
//   - requestAnimationFrame stops in background tabs; the frame delta
//     is clamped so a returning tab resumes where it paused instead of
//     skipping ahead.
// ================================================================

(function () {
  'use strict';

  var PLAYBACK_RATE = 0.4;   // 1 = real time
  var END_PAUSE_MS = 3000;   // wall time, not scaled
  var STAGE_W = 1000;  // under the dashboard 1100px breakpoint: two column grid
  var STAGE_H = 620;
  var MAX_FRAME_DELTA_MS = 100;

  var root = document.getElementById('showcase-pos');
  if (!root) return;

  var q = function (sel) { return root.querySelector(sel); };
  var frame = q('.spos-frame'), scaler = q('.spos-scaler'), stage = q('.spos-stage');
  var cursor = q('.spos-cursor'), ripple = q('.spos-ripple'), hl = q('.spos-highlight'), callout = q('.spos-callout');
  var composer = q('.spos-composer-overlay'), composerClose = q('.spos-composer-close'), btnCreate = q('.spos-btn-create'), quickActions = q('.spos-quick-actions');
  var genreNone = q('.spos-genre-none'), genreInsight = q('.spos-genre-insight');
  var pendingCard = q('.spos-pending-card'), pendingPreview = q('.spos-pending-preview'), editBtn = q('.spos-edit-btn');
  var editOverlay = q('.spos-edit-overlay'), editTextarea = q('.spos-edit-textarea'), editSave = q('.spos-edit-save');
  var detailOverlay = q('.spos-detail-overlay'), detailModal = q('.spos-detail-modal'), publishBtn = q('.spos-publish-btn');
  var pendingStatus = q('.spos-pending-status'), pendingActions = q('.spos-pending-actions'), queueBadge = q('.spos-queue-badge');
  var statPublished = q('.spos-stat-published'), statPending = q('.spos-stat-pending');
  var required = [frame, scaler, stage, cursor, ripple, hl, callout, composer, composerClose, btnCreate, quickActions, genreNone, genreInsight,
    pendingCard, pendingPreview, editBtn, editOverlay, editTextarea, editSave, detailOverlay, detailModal, publishBtn,
    pendingStatus, pendingActions, queueBadge, statPublished, statPending];
  for (var r = 0; r < required.length; r++) { if (!required[r]) return; }

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // On the section, not the stage: the caption in the window bar is outside the stage.
  root.style.setProperty('--spos-rate', String(PLAYBACK_RATE));

  // ---------- Fit the fixed 1000x620 stage to the container ----------
  function fit() {
    var s = Math.min(1, frame.clientWidth / STAGE_W);
    stage.style.transform = 'scale(' + s + ')';
    scaler.style.height = (STAGE_H * s) + 'px';
  }
  window.addEventListener('resize', fit);
  fit();

  // ---------- Geometry in stage coordinates (pre-transform) ----------
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
    cursor.style.left = p.x + 'px';
    cursor.style.top = p.y + 'px';
  }
  function jumpCursor(p) {
    cursor.classList.add('spos-jump');
    cursor.style.left = p.x + 'px';
    cursor.style.top = p.y + 'px';
    void cursor.offsetWidth;
    cursor.classList.remove('spos-jump');
  }
  function clickAt(p) {
    ripple.style.left = p.x + 'px';
    ripple.style.top = p.y + 'px';
    ripple.classList.remove('spos-go');
    void ripple.offsetWidth;
    ripple.classList.add('spos-go');
  }
  function showBox(el) {
    var b = box(el);
    hl.style.left = b.x + 'px'; hl.style.top = b.y + 'px'; hl.style.width = b.w + 'px'; hl.style.height = b.h + 'px';
    hl.classList.add('spos-on');
  }
  function hideBox() { hl.classList.remove('spos-on'); }
  function say(html) { callout.innerHTML = html; callout.classList.add('spos-on'); }
  function hush() { callout.classList.remove('spos-on'); }
  function later(fn, ms) { return setTimeout(fn, ms / PLAYBACK_RATE); }

  var START = { x: 300, y: 600 };

  // ---------- The recording: offsets in ms at 1x ----------
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
  var script = [
    // Scene 1: Create
    { t: 0, run: function () { jumpCursor(START); } },
    { t: 900, run: function () { moveCursor(center(quickActions, 0, -40)); } },
    { t: 2000, run: hoverStep(btnCreate, 4, 2, true, 'hover <b>button.btn-primary</b> "Create"') },
    { t: 3400, run: clickStep(btnCreate, 4, 2, 'click <b>button.btn-primary</b> "Create"') },
    { t: 3650, run: function () {
      btnCreate.classList.remove('spos-hover'); hideBox();
      composer.classList.add('spos-open');
      say('render <b>.composer-overlay</b> (setShowComposer(true))');
    } },
    { t: 4600, run: function () { moveCursor(center(genreNone, -160, 0)); } },
    { t: 5700, run: hoverStep(genreInsight, -180, 0, true, 'hover <b>label.composer-genre</b> "insight"') },
    { t: 7200, run: function () { genreInsight.classList.remove('spos-hover'); hideBox(); moveCursor(center(composerClose, 0, 0)); } },
    { t: 8300, run: clickStep(composerClose, 0, 0, 'click <b>button.composer-close</b>') },
    { t: 8500, run: function () { composer.classList.remove('spos-open'); say('close <b>.composer-overlay</b>'); } },

    // Scene 2: Edit
    { t: 9500, run: function () { moveCursor(center(pendingCard, -40, 0)); } },
    { t: 10700, run: hoverStep(editBtn, 0, 0, true, 'hover <b>button.btn-edit</b> "Edit" (post 3a91, pending_approval)') },
    { t: 12000, run: clickStep(editBtn, 0, 0, 'click <b>button.btn-edit</b> "Edit"') },
    { t: 12250, run: function () {
      editBtn.classList.remove('spos-hover'); hideBox();
      editOverlay.classList.add('spos-open');
      say('render <b>.modal-overlay</b> Edit Post (openEditModal)');
    } },
    { t: 13300, run: function () { moveCursor(center(editTextarea, 120, 40)); } },
    { t: 14400, run: clickStep(editTextarea, 120, 40, 'focus <b>textarea.form-textarea</b> "Content"') },
    { t: 14600, run: function () { editTextarea.classList.add('spos-focus'); } },
    { t: 16200, run: function () { editTextarea.classList.remove('spos-focus'); moveCursor(center(editSave, 0, 0)); } },
    { t: 17300, run: hoverStep(editSave, 0, 0, true, 'hover <b>button.btn-approve</b> "Save Changes"') },
    { t: 18300, run: clickStep(editSave, 0, 0, 'click <b>button.btn-approve</b> "Save Changes" (PATCH /api/posts/3a91)') },
    { t: 18550, run: function () { editSave.classList.remove('spos-hover'); hideBox(); editOverlay.classList.remove('spos-open'); say('close <b>.modal-overlay</b> Edit Post, draft saved'); } },

    // Scene 3: Publish from the post detail modal
    { t: 19600, run: hoverStep(pendingCard, -60, -6, false, 'hover <b>.post-card</b> (post 3a91)') },
    { t: 21000, run: clickStep(pendingCard, -60, -6, 'click <b>.post-card</b> (setSelectedPost)') },
    { t: 21250, run: function () {
      pendingCard.classList.remove('spos-hover'); hideBox();
      detailModal.scrollTop = 0;
      detailOverlay.classList.add('spos-open');
      say('render <b>.modal-overlay</b> post detail (pending_approval)');
    } },
    { t: 22400, run: function () { moveCursor(center(detailModal, 80, 20)); } },
    { t: 23500, run: function () {
      say('scroll <b>.modal-content</b> to the actions');
      detailModal.scrollTop = detailModal.scrollHeight;
    } },
    { t: 24500, run: hoverStep(publishBtn, 0, 0, true, 'hover <b>button.btn-approve</b> "Publish"') },
    { t: 25800, run: clickStep(publishBtn, 0, 0, 'click <b>button.btn-approve</b> "Publish" (POST /api/posts/3a91/approve)') },
    { t: 26050, run: function () {
      publishBtn.classList.remove('spos-hover'); hideBox();
      detailOverlay.classList.remove('spos-open');
      say('close <b>.modal-overlay</b>, status pending_approval to posted');
    } },
    { t: 26600, run: function () {
      pendingStatus.textContent = 'posted';
      pendingStatus.classList.add('spos-status-posted');
      pendingActions.style.visibility = 'hidden';
      pendingCard.classList.add('spos-published');
      queueBadge.textContent = '0';
      statPending.textContent = '0';
      statPublished.textContent = '28';
      say('published: <b>posts.status</b> posted, <b>linkedin_id</b> stamped');
    } },
    { t: 27800, run: function () { moveCursor(START); } },
    { t: 28600, run: function () { say('end of recording'); } }
  ];
  var DURATION = 29500;

  // ---------- Playback loop ----------
  var elapsed = 0, lastTs = 0, fired = [], pausing = false;

  function reset() {
    fired = []; elapsed = 0; lastTs = 0;
    composer.classList.remove('spos-open'); editOverlay.classList.remove('spos-open'); detailOverlay.classList.remove('spos-open');
    hideBox(); hush();
    var hovered = [btnCreate, genreInsight, editBtn, editSave, pendingCard, publishBtn, composerClose, editTextarea];
    for (var i = 0; i < hovered.length; i++) { hovered[i].classList.remove('spos-hover', 'spos-pressed', 'spos-focus'); }
    detailModal.scrollTop = 0;
    pendingStatus.textContent = 'pending approval';
    pendingStatus.classList.remove('spos-status-posted');
    pendingActions.style.visibility = '';
    pendingCard.classList.remove('spos-published');
    queueBadge.textContent = '1';
    statPending.textContent = '1';
    statPublished.textContent = '27';
    jumpCursor(START);
  }

  function tick(ts) {
    if (pausing) return;
    if (lastTs) elapsed += Math.min(ts - lastTs, MAX_FRAME_DELTA_MS) * PLAYBACK_RATE;
    lastTs = ts;
    for (var i = 0; i < script.length; i++) {
      if (!fired[i] && elapsed >= script[i].t) { fired[i] = true; script[i].run(); }
    }
    if (elapsed >= DURATION) {
      pausing = true;
      setTimeout(function () { reset(); pausing = false; window.requestAnimationFrame(tick); }, END_PAUSE_MS);
      return;
    }
    window.requestAnimationFrame(tick);
  }

  function start() {
    if (reducedMotion) { composer.classList.add('spos-open'); return; }
    reset();
    window.requestAnimationFrame(tick);
  }

  // Wait for web fonts so element geometry is final before the first measurement.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { setTimeout(start, 250); });
  } else {
    setTimeout(start, 250);
  }
})();
