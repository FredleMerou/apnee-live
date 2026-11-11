"use strict";

const tokenKey = "apneeLiveAdminToken";

const adminLogin = document.getElementById("adminLogin");
const adminLoginForm = document.getElementById("adminLoginForm");
const adminPassword = document.getElementById("adminPassword");
const adminLoginError = document.getElementById("adminLoginError");
const dashboard = document.getElementById("dashboard");
const participantCount = document.getElementById("participantCount");
const publicUrl = document.getElementById("publicUrl");
const averageChart = document.getElementById("averageChart");
const resultsBody = document.getElementById("resultsBody");
const lastUpdate = document.getElementById("lastUpdate");
const resetButton = document.getElementById("resetButton");

let adminToken = sessionStorage.getItem(tokenKey) || "";
let dashboardData = null;
let socket = null;
let clockLoop = null;

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function effectiveElapsed(timer, now = Date.now()) {
  if (!timer.running || !timer.startedAt) {
    return timer.elapsedMs;
  }

  return timer.elapsedMs + Math.max(0, now - timer.startedAt);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Une erreur est survenue.");
  }

  return payload;
}

function evolutionFromPrevious(values, index) {
  if (index === 0) return null;

  const previous = values[index - 1].value;
  const current = values[index].value;

  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function evolutionMarkup(evolution) {
  if (evolution === null) {
    return '<span class="chart-evolution chart-evolution-empty" aria-hidden="true">&nbsp;</span>';
  }

  const cssClass = evolution > 0
    ? "positive"
    : evolution < 0
      ? "negative"
      : "neutral";
  const sign = evolution > 0 ? "+" : "";

  return `<span class="chart-evolution ${cssClass}">${sign}${evolution} %</span>`;
}

function renderChart(container, values) {
  const maxValue = Math.max(...values.map((item) => item.value), 1000);

  container.innerHTML = values.map((item, index) => {
    const height = item.value > 0
      ? Math.max(4, Math.round((item.value / maxValue) * 205))
      : 4;
    const evolution = evolutionFromPrevious(values, index);

    return `
      <div class="chart-column">
        ${evolutionMarkup(evolution)}
        <span class="chart-value">${formatDuration(item.value)}</span>
        <div class="chart-bar" style="height:${height}px"></div>
        <span class="chart-label">${item.label}</span>
      </div>
    `;
  }).join("");
}

function renderDashboard() {
  if (!dashboardData) return;

  const now = Date.now();
  participantCount.textContent = String(dashboardData.participants.length);

  const averages = [0, 1, 2, 3].map((offset) => {
    const values = dashboardData.participants
      .map((participant) => effectiveElapsed(participant.timers[offset], now))
      .filter((value) => value > 0);

    return {
      label: `Apnée ${offset + 1}`,
      value: values.length
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : 0
    };
  });

  renderChart(averageChart, averages);


  if (!dashboardData.participants.length) {
    resultsBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          Aucun participant inscrit pour le moment.
        </td>
      </tr>
    `;
  } else {
    resultsBody.innerHTML = dashboardData.participants.map((participant, index) => {
      const cells = participant.timers.map((timer) => `
        <td class="${timer.running ? "running-cell" : ""}">
          ${formatDuration(effectiveElapsed(timer, now))}
          ${timer.running ? " ●" : ""}
        </td>
      `).join("");

      return `
        <tr>
          <td>${escapeHtml(participant.name)}${duplicateSuffix(participant, index)}</td>
          ${cells}
        </tr>
      `;
    }).join("");
  }

  lastUpdate.textContent = `Actualisé à ${new Date().toLocaleTimeString("fr-FR")}`;
}

function duplicateSuffix(participant, participantIndex) {
  if (!dashboardData) return "";

  const sameNameBefore = dashboardData.participants
    .slice(0, participantIndex)
    .filter((item) => item.name.toLocaleLowerCase("fr") === participant.name.toLocaleLowerCase("fr"))
    .length;

  const totalSameName = dashboardData.participants
    .filter((item) => item.name.toLocaleLowerCase("fr") === participant.name.toLocaleLowerCase("fr"))
    .length;

  return totalSameName > 1 ? ` (${sameNameBefore + 1})` : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showDashboard() {
  adminLogin.classList.add("hidden");
  dashboard.classList.remove("hidden");

  if (!clockLoop) {
    clockLoop = window.setInterval(renderDashboard, 500);
  }
}

function showLogin(message = "") {
  dashboard.classList.add("hidden");
  adminLogin.classList.remove("hidden");
  adminLoginError.textContent = message;
  adminPassword.focus();
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io();

  socket.on("connect", () => {
    socket.emit("admin:authenticate", adminToken, (result) => {
      if (!result?.ok) {
        sessionStorage.removeItem(tokenKey);
        adminToken = "";
        showLogin("La session animateur a expiré.");
      }
    });
  });

  socket.on("dashboard:update", (payload) => {
    dashboardData = payload;
    renderDashboard();
  });
}

async function loadDashboard() {
  dashboardData = await api("/api/admin/dashboard");
  showDashboard();
  renderDashboard();
  connectSocket();
}

adminLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminLoginError.textContent = "";

  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: adminPassword.value })
    });

    adminToken = result.token;
    sessionStorage.setItem(tokenKey, adminToken);
    adminPassword.value = "";
    await loadDashboard();
  } catch (error) {
    adminLoginError.textContent = error.message;
  }
});

resetButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Effacer définitivement tous les participants et tous les chronos ?"
  );

  if (!confirmed) return;

  try {
    await api("/api/admin/reset", { method: "POST" });
  } catch (error) {
    alert(error.message);
  }
});

async function boot() {
  const config = await fetch("/api/config").then((response) => response.json());
  publicUrl.textContent = config.publicUrl;

  if (!adminToken) {
    showLogin();
    return;
  }

  try {
    await loadDashboard();
  } catch {
    sessionStorage.removeItem(tokenKey);
    adminToken = "";
    showLogin("Reconnecte-toi à l’espace animateur.");
  }
}

boot();
