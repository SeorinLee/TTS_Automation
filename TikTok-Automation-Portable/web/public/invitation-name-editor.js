(function () {
  "use strict";

  var worker = "http://127.0.0.1:8000";
  var requiredBuild = "invitation-name-editor-v42";
  var selectedProfile = window.__gmvSelectedProfileCode || "US_CHROME";
  var selectedStatus = "checking";
  var workerReady = false;
  var parsedItems = [];
  var parseErrors = [];
  var activeJobId = sessionStorage.getItem("invitationNameEditJobId");
  var pollTimer = null;
  var parseTimer = null;
  var parseSequence = 0;
  var terminal = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

  function $(selector) { return document.querySelector(selector); }
  function text(node, value) { if (node) node.textContent = value == null ? "" : String(value); }

  async function json(response) {
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(payload.detail || "요청을 처리하지 못했습니다.");
    return payload;
  }

  function setError(message) {
    var node = $("#rename-error");
    text(node, message || "");
    node.hidden = !message;
  }

  function profileLabel(code) {
    return (code.endsWith("CHROME") ? "Chrome" : "Edge") + " · " + (code.startsWith("US_") ? "US" : "UK");
  }

  function setConnection(dotSelector, labelSelector, status, label) {
    var dot = $(dotSelector);
    dot.className = "status-dot " + status;
    text($(labelSelector), label);
  }

  function localParse(raw) {
    var tokens = String(raw || "").split(/[\r\n,]+/).map(function (value) { return value.trim(); }).filter(Boolean);
    var seen = new Set();
    var items = [];
    var errors = [];
    tokens.forEach(function (name) {
      var key = name.toLowerCase();
      if (seen.has(key)) return;
      var match = name.match(/^(.*?)_([^_]+)_([^_]+)_$/);
      if (!match || !match[1]) {
        errors.push("형식을 확인해주세요: " + name + " (예: D_테스트_0914_)");
        return;
      }
      if (name.length + 1 > 30) {
        errors.push("번호를 붙이면 TikTok 30자 제한을 넘습니다: " + name);
        return;
      }
      seen.add(key);
      items.push({
        order: items.length + 1,
        base_name: name,
        owner: match[1],
        product: match[2],
        date: match[3],
        search_query: match[2] + "_" + match[3]
      });
    });
    return {items: items, errors: errors};
  }

  function appendCells(row, values) {
    values.forEach(function (value) {
      var cell = document.createElement("td");
      text(cell, value);
      row.appendChild(cell);
    });
  }

  function paintPreview(payload) {
    parsedItems = payload.items || [];
    parseErrors = payload.errors || [];
    var body = $("#rename-preview-rows");
    body.replaceChildren();
    parsedItems.forEach(function (item) {
      var row = document.createElement("tr");
      appendCells(row, [item.order, item.base_name, item.product, item.date, "-", item.search_query]);
      body.appendChild(row);
    });
    var error = $("#rename-parse-error");
    text(error, parseErrors.join(" / "));
    error.hidden = !parseErrors.length;
    text($("#rename-preview-summary"), parsedItems.length ? parsedItems.length + "개 입력 · 입력 순서 유지" : "이름을 입력하면 검색어와 번호 부여 기준을 분석합니다.");
    updateStartButton();
  }

  function renderPreview() {
    var raw = $("#rename-input").value;
    paintPreview(localParse(raw));
    window.clearTimeout(parseTimer);
    if (!workerReady || !raw.trim()) return;
    var sequence = ++parseSequence;
    parseTimer = window.setTimeout(async function () {
      try {
        var payload = await json(await fetch(worker + "/invitation-name-edit/parse", {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({profile_code: selectedProfile, invitation_text: raw})
        }));
        if (sequence === parseSequence && $("#rename-input").value === raw) paintPreview(payload);
      } catch (_) {}
    }, 250);
  }

  function updateStartButton() {
    var start = $("#start-rename");
    var running = !!activeJobId && start.dataset.terminal !== "true";
    start.disabled = !workerReady || selectedStatus !== "connected" || !parsedItems.length || !!parseErrors.length || running;
  }

  async function refreshConnections() {
    selectedProfile = window.__gmvSelectedProfileCode || selectedProfile;
    try {
      var health = await json(await fetch(worker + "/health", {cache: "no-store"}));
      workerReady = health.build === requiredBuild;
      setConnection("#rename-worker-dot", "#rename-worker-status", workerReady ? "connected" : "error", workerReady ? "Worker 연결됨" : "Worker 업데이트 필요");
    } catch (_) {
      workerReady = false;
      setConnection("#rename-worker-dot", "#rename-worker-status", "error", "Worker 연결 안됨");
    }
    if (workerReady) {
      try {
        var profiles = await json(await fetch(worker + "/profiles", {cache: "no-store"}));
        var profile = profiles.find(function (item) { return item.profile_code === selectedProfile; });
        selectedStatus = profile ? profile.status : "login_required";
      } catch (_) { selectedStatus = "error"; }
    } else selectedStatus = "error";
    var connected = selectedStatus === "connected";
    setConnection("#rename-login-dot", "#rename-login-status", connected ? "connected" : "login_required", connected ? "로그인 연결됨" : "TikTok 로그인 필요");
    text($("#rename-selected-environment"), profileLabel(selectedProfile));
    text($("#rename-selected-login-copy"), profileLabel(selectedProfile) + (connected ? " 로그인 연결됨" : " 로그인이 필요합니다."));
    updateStartButton();
  }

  function statusLabel(status) {
    return {queued:"대기 중", running:"이름 수정 중", paused:"일시정지", needs_login:"로그인 필요", cancel_requested:"중지 처리 중", cancelled:"중지됨", completed:"완료", completed_with_errors:"일부 완료", failed:"실패"}[status] || status;
  }

  function badge(status) {
    var node = document.createElement("span");
    node.className = "accept-badge status-" + String(status).toLowerCase().replace(/_/g, "-");
    text(node, status);
    return node;
  }

  function renderJob(job) {
    activeJobId = job.id;
    sessionStorage.setItem("invitationNameEditJobId", job.id);
    $("#rename-progress").hidden = false;
    text($("#rename-job-status"), statusLabel(job.status));
    text($("#rename-job-current"), job.current || "-");
    text($("#rename-current-change"), job.current_new_name ? (job.current_original_name + " → " + job.current_new_name) : "변경 대기 중");
    var groups = job.invitation_name_edit_groups || [];
    var rows = job.invitation_name_edit_rows || [];
    var verified = rows.filter(function (item) { return item.status === "VERIFIED"; }).length;
    var failed = rows.filter(function (item) { return item.status === "FAILED"; }).length;
    var total = groups.reduce(function (sum, item) { return sum + Number(item.discovered_total || 0); }, 0);
    var completed = groups.reduce(function (sum, item) { return sum + Number(item.completed_count || 0); }, 0);
    var remaining = groups.reduce(function (sum, item) { return sum + Number(item.remaining_count || 0); }, 0);
    var latest = rows.filter(function (item) { return item.status === "VERIFIED"; }).slice(-1)[0];
    text($("#rename-total"), Math.max(total, completed + remaining, verified + remaining));
    text($("#rename-completed"), completed);
    text($("#rename-remaining"), remaining);
    text($("#rename-current-number"), job.current_number || (latest ? latest.number : "-"));
    text($("#rename-failed"), failed);
    var denominator = Math.max(total, completed + remaining);
    $("#rename-progress-fill").style.width = (denominator ? Math.round(completed / denominator * 100) : 0) + "%";
    text($("#rename-page-status"), job.search_page ? "Target Invitation Search Page " + job.search_page : "Target Invitation Search Page -");

    var resultBody = $("#rename-result-rows");
    resultBody.replaceChildren();
    rows.forEach(function (item) {
      var row = document.createElement("tr");
      appendCells(row, [item.base_name, item.original_name, item.new_name || "-", item.number || "-", item.status, item.message || ""]);
      resultBody.appendChild(row);
    });

    var logs = $("#rename-logs");
    logs.replaceChildren();
    (job.logs || []).slice(-150).forEach(function (entry) {
      var line = document.createElement("div");
      line.className = "accept-log-line";
      var time = document.createElement("time"); text(time, String(entry.time || "").slice(11, 19));
      line.appendChild(time); line.appendChild(badge(entry.status));
      var message = document.createElement("span"); text(message, entry.message); line.appendChild(message);
      logs.appendChild(line);
    });
    logs.scrollTop = logs.scrollHeight;

    var paused = job.status === "paused" || job.status === "needs_login";
    var finished = terminal.has(job.status);
    $("#pause-rename").hidden = paused || finished || job.status === "cancel_requested";
    $("#resume-rename").hidden = !paused;
    $("#cancel-rename").hidden = finished;
    $("#retry-rename").hidden = !finished || !groups.some(function (item) { return item.status !== "COMPLETED"; });
    var download = $("#download-rename");
    download.hidden = false;
    download.href = worker + "/invitation-name-edit-jobs/" + job.id + "/download";
    var start = $("#start-rename");
    start.dataset.terminal = finished ? "true" : "false";
    start.textContent = finished ? "새 초대장 이름수정 시작" : "초대장 이름수정 중...";
    updateStartButton();
  }

  async function poll(jobId) {
    window.clearTimeout(pollTimer);
    try {
      var job = await json(await fetch(worker + "/invitation-name-edit-jobs/" + jobId, {cache: "no-store"}));
      renderJob(job);
      if (!terminal.has(job.status)) pollTimer = window.setTimeout(function () { poll(jobId); }, 1200);
    } catch (error) { setError(error.message); }
  }

  async function startJob() {
    setError("");
    try {
      selectedProfile = window.__gmvSelectedProfileCode || selectedProfile;
      var created = await json(await fetch(worker + "/invitation-name-edit-jobs", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({profile_code: selectedProfile, invitation_text: $("#rename-input").value})
      }));
      activeJobId = created.job_id;
      $("#start-rename").dataset.terminal = "false";
      poll(activeJobId);
    } catch (error) { setError(error.message); }
  }

  async function action(name) {
    if (!activeJobId) return;
    setError("");
    try {
      await json(await fetch(worker + "/invitation-name-edit-jobs/" + activeJobId + "/" + name, {method: "POST"}));
      poll(activeJobId);
    } catch (error) { setError(error.message); }
  }

  function resetPage() {
    window.clearTimeout(pollTimer);
    activeJobId = null;
    sessionStorage.removeItem("invitationNameEditJobId");
    $("#rename-progress").hidden = true;
    $("#rename-input").value = "";
    $("#start-rename").dataset.terminal = "true";
    renderPreview();
    setError("");
  }

  function install() {
    $("#rename-input").addEventListener("input", renderPreview);
    $("#start-rename").addEventListener("click", startJob);
    $("#pause-rename").addEventListener("click", function () { action("pause"); });
    $("#resume-rename").addEventListener("click", function () { action("resume"); });
    $("#cancel-rename").addEventListener("click", function () { action("cancel"); });
    $("#retry-rename").addEventListener("click", function () { action("retry"); });
    $("#reset-rename").addEventListener("click", resetPage);
    window.addEventListener("gmv-profile-change", function (event) {
      selectedProfile = event.detail.profileCode;
      selectedStatus = event.detail.status;
      refreshConnections();
    });
    renderPreview();
    refreshConnections();
    window.setInterval(refreshConnections, 3000);
    if (activeJobId) poll(activeJobId);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
