// ═══════════════════════════════════════════════════════════════
// majiklTrust & Marketing Intelligence — Alpha Homepage Bootstrap
// ═══════════════════════════════════════════════════════════════
//
// Single responsibility: probe the dashboard's /auth/status
// endpoint on load, then update the page based on the result.
//
//   • authenticated    → point CTAs to /app, show user in header
//   • unauthenticated  → keep CTAs pointing to /auth/login (HTML default)
//   • probe failed     → show degraded banner, disable CTAs
//
// CTA button labels never change — they always read "LinkedIn Agent".
// Only the href and disabled state are modified by auth state.
//
// The HTML is fully functional without this script — every CTA has
// a sane default href. This file only enhances the page with
// personalization and a live signal of dashboard health.
//
// Security notes:
//   • User-supplied fields (name, email) are written via
//     textContent, never innerHTML. No HTML injection surface.
//   • No eval, no dynamic code execution, no third-party calls.
//   • fetch uses credentials:'include' so the session cookie is
//     sent on cross-origin dev setups. In production the homepage
//     and dashboard share an origin and the flag is a no-op.
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────

  var STATUS_ENDPOINT = '/auth/status';
  var PROBE_TIMEOUT_MS = 5000;
  var DEFAULT_DASHBOARD_URL = '/app';
  var DEFAULT_LOGIN_URL = '/auth/login';

  // ── Element references ─────────────────────────────────────

  var ctas = document.querySelectorAll('.js-auth-cta');
  var greeting = document.getElementById('user-greeting');
  var banner = document.getElementById('degraded-banner');

  // ── Probe ──────────────────────────────────────────────────

  /**
   * Fetch auth status from the dashboard with a bounded timeout.
   * Resolves to { state: 'auth'|'unauth'|'error', user? }. Never
   * rejects — all failure modes collapse into state:'error'.
   */
  function probe() {
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
      // Ancient browser — don't attempt the probe, leave defaults
      return Promise.resolve({ state: 'unauth' });
    }

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, PROBE_TIMEOUT_MS);

    return fetch(STATUS_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        return { state: 'error' };
      }
      return res.json().then(function (body) {
        if (body && body.authenticated === true) {
          return { state: 'auth', user: body.user || {} };
        }
        return { state: 'unauth' };
      }).catch(function () {
        return { state: 'error' };
      });
    }).catch(function () {
      clearTimeout(timer);
      return { state: 'error' };
    });
  }

  // ── Renderers ──────────────────────────────────────────────

  /**
   * Apply a state to every .js-auth-cta element. Labels are never
   * changed — they always read "LinkedIn Agent" as set in HTML.
   * Only the href and disabled/enabled state are updated.
   */
  function updateCtas(state) {
    for (var i = 0; i < ctas.length; i++) {
      var el = ctas[i];

      if (state === 'error') {
        el.removeAttribute('href');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('tabindex', '-1');
        el.classList.add('is-disabled');
        continue;
      }

      // Not error — clear any prior disabled state
      el.removeAttribute('aria-disabled');
      el.removeAttribute('tabindex');
      el.classList.remove('is-disabled');

      if (state === 'auth') {
        el.setAttribute('href', el.dataset.hrefAuth || DEFAULT_DASHBOARD_URL);
      } else {
        el.setAttribute('href', DEFAULT_LOGIN_URL);
      }
    }
  }

  /**
   * Show the authenticated user's display name or email in the
   * header, alongside the logout button. Falls back silently if
   * neither field is present. Uses textContent exclusively — the
   * DOM string is never interpreted as HTML, so malicious display
   * names cannot inject markup.
   */
  function showGreeting(user) {
    if (!greeting) return;
    if (!user) return;

    var label = '';
    if (typeof user.name === 'string' && user.name.length > 0) {
      label = user.name;
    } else if (typeof user.email === 'string' && user.email.length > 0) {
      label = user.email;
    }

    if (!label) return;

    var nameEl = greeting.querySelector('.user-name');
    if (nameEl) {
      nameEl.textContent = label;
    }
    greeting.hidden = false;
  }

  function showDegradedBanner() {
    if (banner) {
      banner.hidden = false;
    }
  }

  // ── Orchestration ──────────────────────────────────────────

  function apply(result) {
    if (result.state === 'error') {
      updateCtas('error');
      showDegradedBanner();
      return;
    }
    if (result.state === 'auth') {
      updateCtas('auth');
      showGreeting(result.user);
      return;
    }
    updateCtas('unauth');
  }

  function init() {
    probe().then(apply);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
