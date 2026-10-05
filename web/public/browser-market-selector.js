(function () {
  "use strict";

  if (window.__gmvBrowserMarketSelectorLoaded) return;
  window.__gmvBrowserMarketSelectorLoaded = true;
  window.__gmvBrowserMarketSelectorBuild = "browser-market-selector-v12";

  var selectedBrowser = "CHROME";
  var selectedMarket = "US";
  var profiles = [];
  var originalFetch = window.fetch.bind(window);
  var expectedProfiles = ["US", "UK", "DE"].flatMap(function (market) {
    return ["CHROME", "EDGE", "FIREFOX"].map(function (browser) {
      return market + "_" + browser;
    });
  });

  function selectedCode() {
    return selectedMarket + "_" + selectedBrowser;
  }

  function browserName(code) {
    if (code.endsWith("CHROME")) return "Chrome";
    if (code.endsWith("FIREFOX")) return "Firefox";
    return "Edge";
  }

  function marketName(code) {
    if (code.startsWith("US_")) return "United States";
    if (code.startsWith("DE_")) return "Germany";
    return "United Kingdom";
  }

  function marketCode(code) {
    if (code.startsWith("US_")) return "US";
    if (code.startsWith("DE_")) return "DE";
    return "UK";
  }

  function profileStatus(code) {
    var profile = profiles.find(function (item) { return item.profile_code === code; });
    return profile ? profile.status : "checking";
  }

  function statusText(status) {
    return {
      checking: "연결 확인 중",
      connected: "로그인 연결됨",
      login_required: "로그인 필요",
      disconnected: "로그인 필요",
      expired: "로그인 만료",
      connecting: "연결 중",
      running: "작업 중",
      error: "연결 오류"
    }[status] || status;
  }

  async function loadProfiles() {
    try {
      var response = await originalFetch("/api/profiles", { cache: "no-store" });
      if (response.ok) {
        var loaded = await response.json();
        profiles = expectedProfiles.map(function (code) {
          return loaded.find(function (item) { return item.profile_code === code; }) || {
            profile_code: code,
            browser: browserName(code),
            market: marketCode(code),
            status: "login_required",
            last_login_at: null,
            last_verified_at: null
          };
        });
      }
    } catch (_) {}
  }

  function installJobProfileOverride() {
    if (window.__gmvProfileFetchOverride) return;
    window.__gmvProfileFetchOverride = true;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      if (url === "/api/jobs" && init && init.method === "POST" && init.body instanceof FormData) {
        init.body.set("profile_code", selectedCode());
        // One submitted Job must open one automation page/window. Starting another Job from a
        // second site tab creates another independent Worker runtime and browser window.
        init.body.set("concurrency", "1");
      }
      return originalFetch(input, init);
    };
  }

  function chooseLegacySource(grid) {
    var code = selectedCode();
    var button = grid.querySelector(
      '.profile-option[data-profile-code="' + code + '"]'
    );
    if (button && !button.classList.contains("selected")) button.click();
    grid.querySelectorAll(".profile-option[data-profile-code]").forEach(function (option) {
      var active = option.getAttribute("data-profile-code") === code;
      option.classList.toggle("selected", active);
      option.setAttribute("aria-pressed", String(active));
    });
  }

  function syncHome(picker, grid) {
    grid.parentNode.querySelectorAll(".inline-alert:not(.profile-login-helper)").forEach(function (alert) {
      alert.style.display = "none";
    });
    picker.querySelectorAll("[data-browser]").forEach(function (button) {
      var active = button.getAttribute("data-browser") === selectedBrowser;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
    picker.querySelectorAll("[data-market]").forEach(function (button) {
      var active = button.getAttribute("data-market") === selectedMarket;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    });

    var code = selectedCode();
    window.__gmvSelectedProfileCode = code;
    var status = profileStatus(code);
    var host = selectedMarket === "US" ? "affiliate-us.tiktok.com" :
      selectedMarket === "DE" ? "seller-eu.tiktok.com · shop_region=DE" : "affiliate.tiktok.com";
    picker.querySelector("[data-selection-summary]").textContent =
      browserName(code) + " · " + selectedMarket + " · " + host;
    var statusNode = picker.querySelector("[data-selection-status]");
    statusNode.textContent = statusText(status);
    statusNode.className = "picker-status " + status;

    var actionLabel = document.querySelector(".action-bar strong");
    if (actionLabel) actionLabel.textContent = browserName(code) + " · " + selectedMarket;
    if (window.location.pathname === "/") {
      var fileReady = !!document.querySelector(".upload-zone.has-file");
      var submit = document.querySelector(".action-bar .btn.primary");
      if (submit) submit.disabled = !(fileReady && status === "connected");
    }
    window.dispatchEvent(new CustomEvent("gmv-profile-change", {
      detail: { profileCode: code, status: status }
    }));

    var oldAlert = grid.parentNode.querySelector(".profile-login-helper");
    if (oldAlert) oldAlert.remove();
    if (["login_required", "disconnected", "expired", "error"].indexOf(status) >= 0) {
      var helper = document.createElement("p");
      helper.className = "inline-alert profile-login-helper";
      helper.innerHTML = "선택한 조합의 로그인이 필요합니다. <a href=\"/settings?ui=profile-matrix-v12\">로그인 관리 열기 →</a>";
      grid.parentNode.appendChild(helper);
    }
  }

  function createPicker(grid) {
    var picker = document.createElement("div");
    picker.className = "browser-market-picker";
    picker.innerHTML =
      '<div class="picker-group"><span class="picker-label">1. 브라우저 선택</span>' +
      '<div class="picker-options" role="group" aria-label="브라우저 선택">' +
      '<button type="button" data-browser="CHROME"><span class="browser-choice-icon chrome" aria-hidden="true"></span><span class="browser-choice-copy"><strong>Chrome</strong><small>Google Chrome</small></span></button>' +
      '<button type="button" data-browser="EDGE"><span class="browser-choice-icon edge" aria-hidden="true"></span><span class="browser-choice-copy"><strong>Edge</strong><small>Microsoft Edge</small></span></button>' +
      '<button type="button" data-browser="FIREFOX"><span class="browser-choice-icon firefox" aria-hidden="true"></span><span class="browser-choice-copy"><strong>Firefox</strong><small>Mozilla Firefox</small></span></button></div></div>' +
      '<div class="picker-arrow" aria-hidden="true">→</div>' +
      '<div class="picker-group"><span class="picker-label">2. 국가 선택</span>' +
      '<div class="picker-options market-options" role="group" aria-label="국가 선택">' +
      '<button type="button" data-market="US"><span class="picker-code us">US</span><strong>United States</strong></button>' +
      '<button type="button" data-market="UK"><span class="picker-code uk">UK</span><strong>United Kingdom</strong></button>' +
      '<button type="button" data-market="DE"><span class="picker-code de">DE</span><strong>Germany</strong></button></div></div>' +
      '<div class="picker-selection"><span>선택한 환경</span><strong data-selection-summary></strong>' +
      '<small data-selection-status class="picker-status checking"></small></div>';
    picker.addEventListener("click", function (event) {
      var browser = event.target.closest("[data-browser]");
      var market = event.target.closest("[data-market]");
      if (browser) selectedBrowser = browser.getAttribute("data-browser");
      if (market) selectedMarket = market.getAttribute("data-market");
      if (!browser && !market) return;
      chooseLegacySource(grid);
      syncHome(picker, grid);
    });
    return picker;
  }

  function installHome() {
    var grid = document.querySelector(".profile-grid");
    if (!grid) return;
    var description = grid.closest(".step-card").querySelector(".step-heading p");
    if (description) description.textContent = "Chrome, Edge, Firefox 중 하나를 고른 뒤 US/UK/DE 국가를 선택하세요. 선택 조합 그대로 자동화됩니다.";
    grid.classList.add("profile-combo-source");
    var picker = document.querySelector(".browser-market-picker");
    if (!picker) {
      picker = createPicker(grid);
      grid.parentNode.insertBefore(picker, grid);
    }
    syncHome(picker, grid);
  }

  async function profileAction(code, action, errorNode) {
    errorNode.textContent = "";
    try {
      var response = await originalFetch("/api/profiles/" + code + "/" + action, { method: "POST" });
      if (!response.ok) {
        var payload = await response.json().catch(function () { return {}; });
        errorNode.textContent = payload.detail || "요청을 처리하지 못했습니다.";
      }
    } catch (_) {
      errorNode.textContent = "Worker 연결 상태를 확인하세요.";
    }
    window.setTimeout(refreshSettings, 800);
  }

  function profileCard(profile) {
    var code = profile.profile_code;
    var section = document.createElement("section");
    section.className = "account-card custom-account-card";
    section.setAttribute("data-custom-profile", code);
    section.innerHTML =
      '<div class="account-card-head"><span class="market-mark ' +
      (code.startsWith("UK_") ? "cyan" : code.startsWith("DE_") ? "gold" : "blue") + '">' + marketCode(code) + '</span>' +
      '<div><h2>' + browserName(code) + " · " + marketName(code) + '</h2><p>' +
      (code.startsWith("US_") ? "seller-us.tiktok.com" : code.startsWith("DE_") ? "seller-eu.tiktok.com · shop_region=DE" : "seller-uk.tiktok.com") + '</p></div>' +
      '<span class="status-pill ' + profile.status + '">' + statusText(profile.status) + '</span></div>' +
      '<div class="account-times"><div><span>마지막 로그인</span><strong>' +
      (profile.last_login_at || "-") + '</strong></div><div><span>마지막 확인</span><strong>' +
      (profile.last_verified_at || "-") + '</strong></div></div>' +
      '<p class="inline-alert error custom-profile-error"></p>' +
      '<div class="row"><button class="btn primary" data-action="login">' + browserName(code) + ' 로그인</button>' +
      '<button class="btn secondary" data-action="verify">연결 확인</button>' +
      '<button class="btn ghost" data-action="reset">세션 초기화</button></div>';
    var errorNode = section.querySelector(".custom-profile-error");
    section.addEventListener("click", function (event) {
      var button = event.target.closest("[data-action]");
      if (button) profileAction(code, button.getAttribute("data-action"), errorNode);
    });
    return section;
  }

  async function refreshSettings() {
    await loadProfiles();
    var sourceGrid = document.querySelector(".settings-grid:not(.profile-matrix-grid)");
    if (!sourceGrid || !profiles.length) return;
    sourceGrid.style.display = "none";
    var grid = document.querySelector(".profile-matrix-grid");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "settings-grid custom-settings-grid profile-matrix-grid";
      sourceGrid.parentNode.insertBefore(grid, sourceGrid);
    }
    grid.replaceChildren();
    profiles.forEach(function (profile) { grid.appendChild(profileCard(profile)); });
    var intro = document.querySelector(".page-intro .sub");
    if (intro) intro.textContent = "Chrome, Edge, Firefox에서 US/UK/DE를 각각 선택할 수 있으며 로그인은 조합별로 저장됩니다.";
  }

  async function start() {
    installJobProfileOverride();
    async function refreshCurrentPage() {
      if (window.location.pathname === "/" || window.location.pathname.indexOf("/invitations") === 0 || window.location.pathname.indexOf("/invitation-name-edit") === 0) {
        await loadProfiles();
        installHome();
      } else if (window.location.pathname.indexOf("/settings") === 0) {
        await refreshSettings();
      }
    }
    await refreshCurrentPage();
    window.setInterval(refreshCurrentPage, 1000);
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest('a[href="/settings"]');
    if (!link || window.location.pathname.indexOf("/settings") === 0) return;
    event.preventDefault();
    event.stopPropagation();
    window.location.assign("/settings?ui=profile-matrix-v12");
  }, true);

  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest('a[href="/"]');
    if (!link || window.location.pathname === "/") return;
    event.preventDefault();
    event.stopPropagation();
    window.location.assign("/?ui=firefox-de-v12");
  }, true);

  start();
})();
