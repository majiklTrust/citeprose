(function () {
  "use strict";

  var API = window.location.origin;

  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Auth check ───────────────────────────────────────────
  // Fetch the query list. If 403, show access denied wall.

  fetch(API + "/api/platform-admin/queries", { credentials: "include" })
    .then(function (res) {
      if (res.status === 403 || res.status === 401) {
        document.getElementById("auth-wall").style.display = "block";
        return null;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data) return;
      document.getElementById("main-content").style.display = "block";
      renderQueries(data.queries || []);
    })
    .catch(function (err) {
      document.getElementById("auth-wall").style.display = "block";
      console.error("Platform admin load failed:", err);
    });

  // ── Render query cards ───────────────────────────────────

  function renderQueries(queries) {
    var grid = document.getElementById("query-grid");
    if (queries.length === 0) {
      grid.innerHTML = "<p>No queries available.</p>";
      return;
    }

    grid.innerHTML = "";

    // Group: read-only first, then mutations, then destructive
    var sorted = queries.slice().sort(function (a, b) {
      var aw = a.destructive ? 2 : a.readOnly ? 0 : 1;
      var bw = b.destructive ? 2 : b.readOnly ? 0 : 1;
      return aw - bw;
    });

    sorted.forEach(function (q) {
      var card = document.createElement("div");
      card.className = "query-card" + (q.destructive ? " destructive" : q.readOnly ? " read-only" : "");

      var badgeClass = q.destructive ? "badge-destructive" : q.readOnly ? "badge-read" : "badge-write";
      var badgeText = q.destructive ? "destructive" : q.readOnly ? "read-only" : "write";

      var html = '<div class="query-header">';
      html += '<span class="query-label">' + esc(q.label) + '</span>';
      html += '<span class="query-badge ' + badgeClass + '">' + badgeText + '</span>';
      html += '</div>';
      html += '<div class="query-desc">' + esc(q.description) + '</div>';

      // Parameter inputs
      if (q.params && q.params.length > 0) {
        q.params.forEach(function (p) {
          html += '<div class="param-row">';
          html += '<label>' + esc(p.label) + '</label>';
          html += '<input type="text" data-param="' + esc(p.name) + '" placeholder="' + esc(p.type) + '">';
          html += '</div>';
        });
      }

      // Run button
      var btnClass = q.destructive ? "btn-run-destructive" : q.readOnly ? "btn-run-read" : "btn-run-write";
      var btnLabel = q.destructive ? "Run (Destructive)" : "Run";
      html += '<div class="query-actions">';
      html += '<button class="btn-run ' + btnClass + '" data-query-key="' + esc(q.key) + '" data-destructive="' + q.destructive + '">' + btnLabel + '</button>';
      html += '</div>';

      // Result area
      html += '<div class="result-area" id="result-' + esc(q.key) + '"></div>';

      card.innerHTML = html;
      grid.appendChild(card);
    });

    // Bind click handlers
    grid.addEventListener("click", function (e) {
      var btn = e.target.closest(".btn-run");
      if (!btn) return;
      e.preventDefault();
      executeQuery(btn);
    });
  }

  // ── Execute a query ──────────────────────────────────────

  function executeQuery(btn) {
    var key = btn.getAttribute("data-query-key");
    var destructive = btn.getAttribute("data-destructive") === "true";
    var card = btn.closest(".query-card");
    var resultArea = document.getElementById("result-" + key);

    // Collect parameters
    var params = {};
    var inputs = card.querySelectorAll("input[data-param]");
    inputs.forEach(function (input) {
      params[input.getAttribute("data-param")] = input.value.trim();
    });

    // Confirmation for destructive queries
    if (destructive) {
      var confirmed = window.confirm(
        "This is a destructive operation. Are you sure you want to proceed?"
      );
      if (!confirmed) return;
    }

    btn.disabled = true;
    btn.textContent = "Running...";

    fetch(API + "/api/platform-admin/execute", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: key,
        params: params,
        confirmed: destructive
      })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        var data = result.data;
        resultArea.className = "result-area visible";

        if (!result.ok || !data.success) {
          resultArea.innerHTML = '<div class="result-status result-error">' +
            esc(data.error || "Query failed") + '</div>';
          return;
        }

        var html = '<div class="result-status result-success">' +
          esc(data.command || "OK") + ' — ' + data.rowCount + ' row(s)</div>';

        // Render table for read-only queries
        if (data.rows && data.rows.length > 0 && data.fields) {
          html += '<div class="result-table-wrap"><table class="result-table"><thead><tr>';
          data.fields.forEach(function (f) {
            html += '<th>' + esc(f) + '</th>';
          });
          html += '</tr></thead><tbody>';
          data.rows.forEach(function (row) {
            html += '<tr>';
            data.fields.forEach(function (f) {
              var val = row[f];
              if (val === null || val === undefined) val = "—";
              else if (typeof val === "object") val = JSON.stringify(val);
              else val = String(val);
              html += '<td>' + esc(val) + '</td>';
            });
            html += '</tr>';
          });
          html += '</tbody></table></div>';
        }

        resultArea.innerHTML = html;
      })
      .catch(function (err) {
        resultArea.className = "result-area visible";
        resultArea.innerHTML = '<div class="result-status result-error">' +
          esc("Network error: " + err.message) + '</div>';
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = destructive ? "Run (Destructive)" : "Run";
      });
  }
})();
