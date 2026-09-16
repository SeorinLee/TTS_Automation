(function () {
  "use strict";

  function addStylesheet() {
    var existing = document.querySelector('link[data-app-shell-style]');
    if (existing) {
      existing.href = "/app-shell.css?v=23";
      return;
    }
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/app-shell.css?v=23";
    link.setAttribute("data-app-shell-style", "true");
    document.head.appendChild(link);
  }

  function addSiteIcon() {
    var href = "/ta-favicon-128.png?v=1";
    var icons = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
    icons.forEach(function (icon) {
      icon.href = href;
      icon.type = "image/png";
    });
    if (!icons.length) {
      var icon = document.createElement("link");
      icon.rel = "icon";
      icon.type = "image/png";
      icon.sizes = "128x128";
      icon.href = href;
      document.head.appendChild(icon);
    }
  }

  function addBrowserMarketSelector() {
    if (window.location.pathname !== "/" && window.location.pathname.indexOf("/settings") !== 0) return;
    if (document.querySelector('script[data-browser-market-selector]')) return;
    var script = document.createElement("script");
    script.src = "/browser-market-selector.js?v=10";
    script.defer = true;
    script.setAttribute("data-browser-market-selector", "true");
    document.head.appendChild(script);
  }

  function addCrayonFilters() {
    if (document.querySelector("[data-crayon-filters]")) return;
    var holder = document.createElement("div");
    holder.setAttribute("data-crayon-filters", "true");
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    holder.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" focusable="false">' +
      '<defs>' +
      '<filter id="crayon-rough" x="-8%" y="-12%" width="116%" height="124%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.018 0.075" numOctaves="2" seed="19" result="noise"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="noise" scale="3.2" xChannelSelector="R" yChannelSelector="G" result="shifted"/>' +
      '<feGaussianBlur in="shifted" stdDeviation="0.16"/>' +
      '</filter>' +
      '<filter id="crayon-rough-small" x="-12%" y="-18%" width="124%" height="136%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.035 0.12" numOctaves="2" seed="31" result="noise"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="noise" scale="2" xChannelSelector="R" yChannelSelector="G" result="shifted"/>' +
      '<feGaussianBlur in="shifted" stdDeviation="0.12"/>' +
      '</filter>' +
      '</defs></svg>';
    document.body.appendChild(holder);
  }

  function currentSection() {
    if (window.location.pathname.indexOf("/invitation-name-edit") === 0) {
      return "invitation-name-edit";
    }
    return window.location.pathname.indexOf("/invitations") === 0
      ? "invitations"
      : "gmv";
  }

  function updateActiveMenu(shell) {
    var section = currentSection();
    shell.querySelectorAll("[data-automation-section]").forEach(function (link) {
      var active = link.getAttribute("data-automation-section") === section;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function createShell() {
    var existing = document.querySelector(".automation-shell");
    if (existing) return existing;

    var shell = document.createElement("header");
    shell.className = "automation-shell";
    shell.innerHTML =
      '<div class="automation-shell-inner">' +
      '<a class="automation-brand" href="/" aria-label="TikTok Automation 홈">' +
      '<span class="automation-brand-mark" aria-hidden="true">TA</span>' +
      '<span>TikTok Automation</span>' +
      "</a>" +
      '<nav class="automation-nav" aria-label="자동화 메뉴">' +
      '<a href="/" data-automation-section="gmv">GMV 자동화</a>' +
      '<a href="/invitations" data-automation-section="invitations">초대장 조회</a>' +
      '<a href="/invitation-name-edit.html" data-automation-section="invitation-name-edit">초대장 이름수정</a>' +
      "</nav>" +
      "</div>";

    document.body.insertBefore(shell, document.body.firstChild);
    return shell;
  }

  function createCreditBar() {
    var existing = document.querySelector(".automation-credit-bar");
    if (existing) return existing;

    var footer = document.createElement("footer");
    footer.className = "automation-credit-bar";
    footer.setAttribute("role", "contentinfo");
    footer.textContent = "이서린 Email:lsr20538@brand501.com";
    document.body.appendChild(footer);
    return footer;
  }

  function installResultTableFrames() {
    function wrapResultTables() {
      document.querySelectorAll(".result-table.card.scroll, .invitation-result-table.card.scroll").forEach(function (resultTable) {
        if (resultTable.parentElement && resultTable.parentElement.classList.contains("crayon-result-frame")) return;

        var frame = document.createElement("div");
        frame.className = "crayon-result-frame";
        if (resultTable.classList.contains("invitation-result-table")) {
          frame.classList.add("invitation-result-frame");
        }
        resultTable.parentNode.insertBefore(frame, resultTable);
        frame.appendChild(resultTable);
      });
    }

    wrapResultTables();
    if (window.__crayonResultTableObserver) return;

    window.__crayonResultTableObserver = new MutationObserver(function () {
      wrapResultTables();
    });
    window.__crayonResultTableObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function install() {
    addCrayonFilters();
    addSiteIcon();
    addStylesheet();
    addBrowserMarketSelector();
    installResultTableFrames();
    var shell = createShell();
    createCreditBar();
    updateActiveMenu(shell);
    document.documentElement.classList.add("app-shell-ready");

    window.addEventListener("popstate", function () {
      updateActiveMenu(shell);
    });
    document.addEventListener("click", function (event) {
      if (event.target && event.target.closest("a")) {
        window.setTimeout(function () {
          updateActiveMenu(shell);
        }, 0);
      }
    });
  }

  addSiteIcon();
  addStylesheet();
  if (document.readyState === "complete") window.setTimeout(install, 50);
  else window.addEventListener("load", function () { window.setTimeout(install, 50); }, { once: true });
})();
