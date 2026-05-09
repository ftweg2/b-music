const config = window.KERNEL_WEBUI_CONFIG || {};

const $ = (id) => document.getElementById(id);
let currentQrUrl = "";

function baseUrl() {
  return $("baseUrl").value.replace(/\/+$/, "");
}

function show(target, payload) {
  const el = typeof target === "string" ? $(target) : target;
  el.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function showError(target, error) {
  show(target, { 错误: String(error.message || error) });
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = payload && payload.detail ? payload.detail : payload;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

function ownerId() {
  return $("profileOwner").value.trim();
}

function profileId() {
  return $("profileId").value.trim();
}

function jobId() {
  return $("jobId").value.trim();
}

function outputs() {
  return Array.from(document.querySelectorAll('input[name="outputs"]:checked')).map((input) => input.value);
}

async function readCookiePayload() {
  const file = $("cookieFile").files[0];
  if (file) {
    return file.text();
  }
  return $("cookieText").value;
}

function clearCookieInputs() {
  $("cookieText").value = "";
  $("cookieFile").value = "";
}

function renderQr(relativeUrl) {
  if (!relativeUrl) {
    $("qrPanel").hidden = true;
    currentQrUrl = "";
    return;
  }
  currentQrUrl = `${baseUrl()}${relativeUrl}`;
  $("loginQrImage").src = withCacheBust(currentQrUrl);
  $("qrPanel").hidden = false;
}

function refreshQrImage() {
  if (!currentQrUrl) {
    return;
  }
  $("loginQrImage").src = withCacheBust(currentQrUrl);
}

function withCacheBust(url) {
  return `${url}${url.includes("?") ? "&" : "?"}_ts=${Date.now()}`;
}

function renderTable(hostId, columns, rows, linkBuilder) {
  const host = $(hostId);
  host.textContent = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column.label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      if (linkBuilder && column.key === "download") {
        const link = document.createElement("a");
        link.href = linkBuilder(row);
        link.textContent = "下载";
        link.target = "_blank";
        td.appendChild(link);
      } else {
        td.textContent = String(row[column.key] ?? "");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

async function checkHealth() {
  try {
    show("healthResult", await apiFetch("/health", { method: "GET" }));
  } catch (error) {
    showError("healthResult", error);
  }
}

async function createProfile() {
  try {
    const payload = await apiFetch("/v1/profiles", {
      method: "POST",
      body: JSON.stringify({ external_owner_id: ownerId() })
    });
    $("profileId").value = payload.profile_id || $("profileId").value;
    show("profileResult", payload);
  } catch (error) {
    showError("profileResult", error);
  }
}

async function loginStart() {
  try {
    const payload = await apiFetch(`/v1/profiles/${encodeURIComponent(profileId())}/login/start`, {
      method: "POST",
      body: JSON.stringify({ external_owner_id: ownerId() })
    });
    renderQr(payload.qr_image_url);
    show("profileResult", payload);
  } catch (error) {
    showError("profileResult", error);
  }
}

async function loginStatus() {
  try {
    const query = new URLSearchParams({ external_owner_id: ownerId() });
    show("profileResult", await apiFetch(`/v1/profiles/${encodeURIComponent(profileId())}/login/status?${query}`));
  } catch (error) {
    showError("profileResult", error);
  }
}

async function importCookie() {
  const cookiePayload = await readCookiePayload();
  clearCookieInputs();
  try {
    const payload = await apiFetch(`/v1/profiles/${encodeURIComponent(profileId())}/cookies/import`, {
      method: "POST",
      body: JSON.stringify({
        external_owner_id: ownerId(),
        format: $("cookieFormat").value,
        cookies: cookiePayload,
        source_note: "manually provided by account owner"
      })
    });
    show("cookieResult", payload);
  } catch (error) {
    showError("cookieResult", error);
  }
}

async function submitJob() {
  const strategyMode = $("strategyMode").value;
  const body = {
    job_id: jobId(),
    external_owner_id: ownerId(),
    profile_id: profileId(),
    url: $("jobUrl").value.trim(),
    strategy_mode: strategyMode,
    outputs: outputs()
  };
  if (strategyMode === "force") {
    body.strategy = $("forceStrategy").value;
  } else {
    body.strategy_order = ["api_dash", "browser_network", "mse_sourcebuffer"];
  }
  try {
    show("jobResult", await apiFetch("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(body)
    }));
  } catch (error) {
    showError("jobResult", error);
  }
}

async function pollJob() {
  try {
    show("jobResult", await apiFetch(`/v1/jobs/${encodeURIComponent(jobId())}`));
  } catch (error) {
    showError("jobResult", error);
  }
}

async function listArtifacts() {
  try {
    const payload = await apiFetch(`/v1/jobs/${encodeURIComponent(jobId())}/artifacts`);
    renderTable(
      "artifactResult",
      [
        { key: "name", label: "名称" },
        { key: "size_bytes", label: "大小" },
        { key: "sha256", label: "sha256" },
        { key: "producer_strategy", label: "生成策略" },
        { key: "download", label: "下载" }
      ],
      payload.artifacts || [],
      (row) => `${baseUrl()}/v1/jobs/${encodeURIComponent(jobId())}/artifacts/${encodeURIComponent(row.name)}`
    );
  } catch (error) {
    $("artifactResult").textContent = String(error.message || error);
  }
}

async function listStrategies() {
  try {
    show("strategyResult", await apiFetch("/v1/strategies"));
  } catch (error) {
    $("strategyResult").textContent = String(error.message || error);
  }
}

async function strategyMetrics() {
  try {
    const payload = await apiFetch("/v1/strategies/metrics");
    const rows = (payload.metrics || []).map((metric) => ({
      ...metric,
      success_rate: metric.total_attempts ? (metric.success_count / metric.total_attempts).toFixed(3) : "0.000"
    }));
    renderTable(
      "strategyResult",
      [
        { key: "strategy_name", label: "策略" },
        { key: "total_attempts", label: "尝试次数" },
        { key: "success_count", label: "成功" },
        { key: "fail_count", label: "失败" },
        { key: "success_rate", label: "成功率" },
        { key: "avg_duration_ms", label: "平均耗时 ms" },
        { key: "last_failure_reason", label: "最近失败原因" }
      ],
      rows
    );
  } catch (error) {
    $("strategyResult").textContent = String(error.message || error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("baseUrl").value = config.defaultBaseUrl || "http://localhost:8000";
  $("healthBtn").addEventListener("click", checkHealth);
  $("createProfileBtn").addEventListener("click", createProfile);
  $("loginStartBtn").addEventListener("click", loginStart);
  $("loginStatusBtn").addEventListener("click", loginStatus);
  $("refreshQrBtn").addEventListener("click", refreshQrImage);
  $("importCookieBtn").addEventListener("click", importCookie);
  $("submitJobBtn").addEventListener("click", submitJob);
  $("pollJobBtn").addEventListener("click", pollJob);
  $("listArtifactsBtn").addEventListener("click", listArtifacts);
  $("listStrategiesBtn").addEventListener("click", listStrategies);
  $("strategyMetricsBtn").addEventListener("click", strategyMetrics);
});
