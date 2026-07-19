// ═══════════════════════════════════════════════════════════════
// public/shared/manager-nav.js — Common nav for manager pages
// ═══════════════════════════════════════════════════════════════
// Renders a navigation bar with links to Topics, Feeds, and
// Manage (owner only). Included by each manager page.
//
// Usage:
//   <div id="manager-nav"></div>
//   <script src="/app/shared/manager-nav.js"></script>
//
// The script reads the user's role from /api/status and
// conditionally shows links based on permissions:
//   Topics, Feeds → owner + editor (manage_own_topics)
//   Manage        → owner only
//
// The current page is highlighted (not linked).
// ═══════════════════════════════════════════════════════════════

(function () {
  var API = window.location.origin;
  var currentPath = window.location.pathname.replace(/\/+$/, '');

  var pages = [
    { path: '/app/linkedin', label: 'LinkedIn', perm: 'manage_linkedin' },
    { path: '/app/analytics', label: 'Analytics', perm: 'view_analytics' },
    { path: '/app/advocacy', label: 'Advocacy', perm: 'view_dashboard' },
    // Guarded the same way the page itself is: the entitlement wall.
    // cap follows the F4 fail-visible convention below.
    { path: '/app/image-studio', label: 'Image Studio', perm: 'preview_post', cap: 'image_studio' },
    { path: '/app/topics', label: 'Topics', roles: ['owner', 'editor'] },
    { path: '/app/feeds', label: 'Feeds', roles: ['owner', 'editor'] },
    { path: '/app/billing', label: 'Billing', perm: 'manage_billing' },
    { path: '/app/admin', label: 'Manage', roles: ['owner'] }
  ];

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  var OM_PAGES = ['/app/analytics', '/app/linkedin', '/app/advocacy'];

  function renderNav(role, omDisabled, permissions, capabilities) {
    var container = document.getElementById('manager-nav');
    if (!container) return;

    var html = '<nav class="manager-nav">';
    html += '<a href="/app" class="manager-nav-link">← Dashboard</a>';

    pages.forEach(function (page) {
      if (page.perm) {
        // Organization Manager pages: gated by the permission
        // matrix, the single source of truth (never role names).
        if ((permissions || []).indexOf(page.perm) === -1) return;
      } else if (page.roles.indexOf(role) === -1) return;
      // Payments (2.3.4): OM links need the operator flag AND the
      // paid capability; either alone hides them.
      // AUDIT F4 (2.4.2): capabilities === null signals a server
      // that predates the subscription field (mixed-version
      // install). Hiding paid links on missing evidence strands a
      // paying user; the server gates enforce regardless, so the
      // nav fails visible, not closed.
      // Capability-gated pages (Image Studio): hidden without the
      // paid capability, fail-visible on missing evidence (F4), and
      // the server gates enforce regardless of what the nav shows.
      if (page.cap) {
        var capOk = capabilities === null || (capabilities || []).indexOf(page.cap) !== -1;
        if (!capOk) return;
      }
      var omEntitled = capabilities === null || (capabilities || []).indexOf('organization_manager') !== -1;
      if ((omDisabled || !omEntitled) && OM_PAGES.indexOf(page.path) !== -1) return;

      var isActive = currentPath === page.path;
      if (isActive) {
        html += '<span class="manager-nav-link manager-nav-active">' + esc(page.label) + '</span>';
      } else {
        html += '<a href="' + page.path + '/" class="manager-nav-link">' + esc(page.label) + '</a>';
      }
    });

    html += '</nav>';
    container.innerHTML = html;
  }

  // Fetch user role and render
  fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.user && data.user.role) {
        renderNav(data.user.role, data.organizationManager === 'disabled', data.permissions || [], data.subscription ? (data.subscription.capabilities || []) : null);
      }
    })
    .catch(function () { /* silent — page handles its own access check */ });
})();
