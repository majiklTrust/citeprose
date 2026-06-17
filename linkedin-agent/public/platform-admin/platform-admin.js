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
      bindGenrePanel();
      loadGenreOptions();
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
      html += '<div class="query-header-main">';
      html += '<span class="query-label">' + esc(q.label) + '</span>';
      html += '<span class="query-badge ' + badgeClass + '">' + badgeText + '</span>';
      html += '</div>';

      // Capability — sits inline in the header row on desktop,
      // wraps to its own line on narrow viewports.
      if (q.capability) {
        html += '<div class="query-capability">';
        html += '<span class="capability-tag">Capability</span>';
        html += '<span class="capability-text">' + esc(q.capability) + '</span>';
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="query-desc">' + esc(q.description) + '</div>';

      // Parameter inputs
      if (q.params && q.params.length > 0) {
        q.params.forEach(function (p) {
          html += '<div class="param-row">';
          html += '<label>' + esc(p.label) + '</label>';
          if (p.type === "select" && p.source === "models") {
            html += '<select data-param="' + esc(p.name) + '" data-source="models" disabled>';
            html += '<option value="">Loading models…</option>';
            html += '</select>';
          } else if (p.type === "select" && p.optgroups) {
            html += '<select data-param="' + esc(p.name) + '">';
            p.optgroups.forEach(function (g) {
              html += '<optgroup label="' + esc(g.group) + '">';
              g.options.forEach(function (opt) {
                html += '<option value="' + esc(opt) + '">' + esc(opt) + '</option>';
              });
              html += '</optgroup>';
            });
            html += '</select>';
          } else {
            html += '<input type="text" data-param="' + esc(p.name) + '" placeholder="' + esc(p.type) + '">';
          }
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

    // Populate any dynamic model dropdowns from the live catalog
    populateModelSelects();
  }

  // ── Populate model dropdowns from the live Anthropic catalog ──

  function populateModelSelects() {
    var selects = document.querySelectorAll('select[data-source="models"]');
    if (selects.length === 0) return;

    fetch(API + "/api/platform-admin/models", { credentials: "include" })
      .then(function (r) {
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(function (data) {
        var optgroups = data.optgroups || [];
        selects.forEach(function (sel) {
          if (optgroups.length === 0) {
            sel.innerHTML = '<option value="">No models available</option>';
            return;
          }
          var html = "";
          optgroups.forEach(function (g) {
            html += '<optgroup label="' + esc(g.group) + '">';
            g.options.forEach(function (opt) {
              html += '<option value="' + esc(opt) + '">' + esc(opt) + '</option>';
            });
            html += '</optgroup>';
          });
          sel.innerHTML = html;
          sel.disabled = false;
        });
      })
      .catch(function () {
        selects.forEach(function (sel) {
          sel.innerHTML = '<option value="">Unable to load models</option>';
        });
      });
  }

  // ── Execute a query ──────────────────────────────────────

  function executeQuery(btn) {
    var key = btn.getAttribute("data-query-key");
    var destructive = btn.getAttribute("data-destructive") === "true";
    var card = btn.closest(".query-card");
    var resultArea = document.getElementById("result-" + key);

    // Collect parameters (text inputs and dropdown selects)
    var params = {};
    var inputs = card.querySelectorAll("[data-param]");
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
  // ── Content genre upsert panel ───────────────────────────
  // Posts to the dedicated /content-genre endpoint (NOT /execute).
  // Server-side encryption; this sends plaintext over the
  // authenticated request and shows the result. Any genre may be
  // created or updated, including 'default'. Overwriting an
  // existing template prompts for confirmation (HTTP 409), then
  // resends with confirmed:true.

  function bindGenrePanel() {
    var btn = document.getElementById("genre-submit");
    if (!btn) return;
    btn.addEventListener("click", function () { submitGenre(false); });

    var select = document.getElementById("genre-select");
    if (select) {
      select.addEventListener("change", function () { applyGenreSelection(); });
    }
  }

  // ── Genre loader dropdown ─────────────────────────────────
  // Fetches genre METADATA only (genre + description) via the
  // content-generator-genres registry query. Never fetches or
  // displays template plaintext — that stays behind the vault
  // boundary. Selecting a genre loads its name and description
  // into the editable fields; the template textarea stays manual.

  var GENRE_META = {};   // genre -> description

  function loadGenreOptions() {
    fetch(API + "/api/platform-admin/execute", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "content-generator-genres", params: {}, confirmed: false })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success || !data.rows) return;
        var select = document.getElementById("genre-select");
        if (!select) return;

        GENRE_META = {};
        // Rebuild options: "New genre" first, then each existing genre.
        select.innerHTML = '<option value="__new__">— New genre —</option>';
        data.rows.forEach(function (row) {
          GENRE_META[row.genre] = row.description || "";
          var opt = document.createElement("option");
          opt.value = row.genre;
          opt.textContent = row.genre;
          select.appendChild(opt);
        });

        // Default to 'default' if present, then load its metadata.
        if (Object.prototype.hasOwnProperty.call(GENRE_META, "default")) {
          select.value = "default";
        }
        applyGenreSelection();
      })
      .catch(function (err) {
        console.error("Genre list load failed:", err);
      });
  }

  function applyGenreSelection() {
    var select = document.getElementById("genre-select");
    var nameEl = document.getElementById("genre-name");
    var descEl = document.getElementById("genre-desc");
    if (!select) return;

    var choice = select.value;
    if (choice === "__new__") {
      // New genre: clear fields for fresh entry.
      nameEl.value = "";
      descEl.value = "";
      return;
    }
    // Existing genre: load name + description (metadata only).
    nameEl.value = choice;
    descEl.value = GENRE_META[choice] || "";
  }

  function setGenreBusy(busy) {
    var btn = document.getElementById("genre-submit");
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? "Saving..." : "Save Genre Template";
  }

  function submitGenre(confirmed) {
    var nameEl = document.getElementById("genre-name");
    var descEl = document.getElementById("genre-desc");
    var tmplEl = document.getElementById("genre-template");
    var resultEl = document.getElementById("genre-result");

    var genre = (nameEl.value || "").trim();
    var description = (descEl.value || "").trim();
    var template = tmplEl.value || "";

    // Client-side pre-validation mirrors the server rules so the
    // admin gets instant feedback. 'default' is a valid genre.
    // The server re-validates — this is convenience, not the
    // security boundary.
    resultEl.className = "genre-result";
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(genre)) {
      showGenreResult(resultEl, false, "Genre must be lowercase, start with a letter, 2–32 chars.");
      return;
    }
    if (template.trim().length === 0) {
      showGenreResult(resultEl, false, "Template text is required.");
      return;
    }
    if (description.length === 0) {
      showGenreResult(resultEl, false, "Description is required.");
      return;
    }

    setGenreBusy(true);

    fetch(API + "/api/platform-admin/content-genre", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        genre: genre, template: template,
        description: description, confirmed: confirmed === true
      })
    })
      .then(function (res) {
        return res.json().then(function (d) {
          return { status: res.status, ok: res.ok, data: d };
        });
      })
      .then(function (r) {
        // 409 → template exists; confirm overwrite, then resend.
        if (r.status === 409 && r.data.needsConfirm) {
          setGenreBusy(false);
          if (window.confirm(r.data.message)) {
            submitGenre(true);
          }
          return;
        }
        setGenreBusy(false);
        if (!r.ok || !r.data.success) {
          showGenreResult(resultEl, false, r.data.error || "Save failed");
          return;
        }
        var verb = r.data.action === "updated" ? "updated" : "created";
        showGenreResult(resultEl, true, "Genre '" + genre + "' " + verb + ".");
        // Clear inputs only on create, so an update leaves the
        // fields in place for further edits.
        if (r.data.action === "created") {
          nameEl.value = "";
          descEl.value = "";
          tmplEl.value = "";
        }
        // Refresh the dropdown so a newly created genre appears and
        // an updated description is reflected.
        loadGenreOptions();
      })
      .catch(function (err) {
        setGenreBusy(false);
        showGenreResult(resultEl, false, "Network error: " + err.message);
      });
  }

  function showGenreResult(el, ok, msg) {
    el.className = "genre-result visible " + (ok ? "ok" : "err");
    el.textContent = msg;
  }
})();
