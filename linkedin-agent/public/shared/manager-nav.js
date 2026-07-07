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
    { path: '/app/analytics', label: 'Analytics', roles: ['owner', 'editor', 'viewer'] },
    { path: '/app/topics', label: 'Topics', roles: ['owner', 'editor'] },
    { path: '/app/feeds', label: 'Feeds', roles: ['owner', 'editor'] },
    { path: '/app/admin', label: 'Manage', roles: ['owner'] }
  ];

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function renderNav(role) {
    var container = document.getElementById('manager-nav');
    if (!container) return;

    var html = '<nav class="manager-nav">';
    html += '<a href="/app" class="manager-nav-link">← Dashboard</a>';

    pages.forEach(function (page) {
      if (page.roles.indexOf(role) === -1) return;

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
        renderNav(data.user.role);
      }
    })
    .catch(function () { /* silent — page handles its own access check */ });
})();
