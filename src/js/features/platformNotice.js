// SPDX-License-Identifier: MIT
// ===================================================================================
// platformNotice.js — tell a standalone user where the platform feature lives.
// ===================================================================================
//
// Excel (.xlsx) export is the injected gate layer (see
// architecture/three-tier-architecture.md and assets/table-formatter/ui/
// xlsxExport.js). It is deliberately absent from the forkable tool: a fork gets
// the deterministic editor, not the platform capability.
//
// Absent is the correct behaviour, but a dead option in the dropdown is
// indistinguishable from a broken one. This renders the difference explicitly —
// the feature exists, it runs on the platform, here is the link — instead of
// leaving someone to guess whether they hit a bug.
//
// MIT, and deliberately so: a fork keeps this file. The honest thing for a fork
// to show is "this capability is not part of what you forked", which is exactly
// what it says. Nothing here reveals how the feature or its gate work.

(function () {
  var PLATFORM_URL = "https://ginexys.com/app/tafne";

  function _card(copy) {
    var wrap = document.createElement("div");
    wrap.className = "gx-platform-notice";
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" class="gx-platform-notice-icon">' +
      '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>' +
      '<div class="gx-platform-notice-title"></div>' +
      '<p class="gx-platform-notice-body"></p>' +
      '<a class="gx-platform-notice-cta" target="_blank" rel="noopener noreferrer"></a>';
    wrap.querySelector(".gx-platform-notice-title").textContent = copy.title;
    wrap.querySelector(".gx-platform-notice-body").textContent = copy.body;
    var a = wrap.querySelector(".gx-platform-notice-cta");
    a.textContent = copy.cta;
    a.href = PLATFORM_URL;
    return wrap;
  }

  function _render() {
    var el = document.getElementById("xlsx-export-slot");
    if (!el) return;
    var select = document.getElementById("exportFormat");
    var isXlsx = select && select.value === "xlsx";

    // The platform injected the real capability, or the user isn't even
    // looking at the xlsx option right now — either way, nothing to show.
    if (!isXlsx || window.GxTableIdeXlsxExport) {
      el.innerHTML = "";
      return;
    }
    if (el.querySelector(".gx-platform-notice")) return;
    el.appendChild(
      _card({
        title: "Excel export runs on the Ginexys platform",
        body:
          "Excel (.xlsx) export is part of the Ginexys platform rather than " +
          "the standalone editor — available when signed in.",
        cta: "Open this tool on ginexys.com →",
      }),
    );
  }

  window.initTableIdePlatformNotices = _render;

  function _boot() {
    var select = document.getElementById("exportFormat");
    if (select) select.addEventListener("change", _render);
    // Deferred: the injected script arrives on the iframe's load handler,
    // after this file has already run. Checking immediately would draw the
    // notice over a capability that is about to work.
    setTimeout(_render, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _boot);
  } else {
    _boot();
  }
})();