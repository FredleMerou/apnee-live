"use strict";

const storageKey = "apneeLiveParticipantId";

const registrationCard = document.getElementById("registrationCard");
const registrationForm = document.getElementById("registrationForm");
const participantNameInput = document.getElementById("participantName");
const registrationError = document.getElementById("registrationError");
const timerArea = document.getElementById("timerArea");
const displayName = document.getElementById("displayName");
const safetyMessage = document.getElementById("safetyMessage");
const timersGrid = document.getElementById("timersGrid");
const personalChart = document.getElementById("personalChart");
const changeParticipantButton = document.getElementById("changeParticipantButton");

let participant = null;
let renderLoop = null;
let actionInProgress = new Set();

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function effectiveElapsed(timer) {
  if (!timer.running || !timer.startedAt) {
    return timer.elapsedMs;
  }

  return timer.elapsedMs + Math.max(0, Date.now() - timer.startedAt);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
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

function createTimerCards() {
  timersGrid.innerHTML = "";

  for (let index = 1; index <= 4; index += 1) {
    const card = document.createElement("article");
    card.className = "card timer-card";
    card.dataset.timerIndex = String(index);

    card.innerHTML = `
      <h2>Apnée ${index}</h2>
      <div class="timer-display" data-display="${index}">00:00</div>
      <button class="timer-button" data-action="${index}" type="button">Start</button>
    `;

    card.querySelector("button").addEventListener("click", () => toggleTimer(index));
    timersGrid.appendChild(card);
  }
}

function renderParticipant() {
  if (!participant) return;

  displayName.textContent = participant.name;

  for (const timer of participant.timers) {
    const display = document.querySelector(`[data-display="${timer.index}"]`);
    const button = document.querySelector(`[data-action="${timer.index}"]`);

    if (!display || !button) continue;

    display.textContent = formatDuration(effectiveElapsed(timer));
    button.textContent = timer.running ? "Stop" : "Start";
    button.classList.toggle("running", timer.running);
    button.disabled = actionInProgress.has(timer.index);
  }

  renderChart(personalChart, participant.timers.map((timer) => ({
    label: `Apnée ${timer.index}`,
    value: effectiveElapsed(timer)
  })));
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
      ? Math.max(4, Math.round((item.value / maxValue) * 145))
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

async function toggleTimer(index) {
  if (!participant || actionInProgress.has(index)) return;

  const timer = participant.timers[index - 1];
  actionInProgress.add(index);
  renderParticipant();

  try {
    const action = timer.running ? "stop" : "start";
    participant = await api(
      `/api/participants/${participant.id}/timers/${index}/${action}`,
      { method: "POST" }
    );
  } catch (error) {
    alert(error.message);
  } finally {
    actionInProgress.delete(index);
    renderParticipant();
  }
}

function showParticipantArea() {
  registrationCard.classList.add("hidden");
  timerArea.classList.remove("hidden");

  if (!renderLoop) {
    renderLoop = window.setInterval(renderParticipant, 250);
  }

  renderParticipant();
}

function showRegistration() {
  timerArea.classList.add("hidden");
  registrationCard.classList.remove("hidden");
  registrationError.textContent = "";
  participantNameInput.focus();
}

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  registrationError.textContent = "";

  try {
    participant = await api("/api/participants", {
      method: "POST",
      body: JSON.stringify({ name: participantNameInput.value })
    });

    localStorage.setItem(storageKey, participant.id);
    showParticipantArea();
  } catch (error) {
    registrationError.textContent = error.message;
  }
});

changeParticipantButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Changer de participant créera une nouvelle ligne dans les résultats. Continuer ?"
  );

  if (!confirmed) return;

  localStorage.removeItem(storageKey);
  participant = null;
  participantNameInput.value = "";
  showRegistration();
});

async function boot() {
  createTimerCards();

  const config = await api("/api/config");
  safetyMessage.textContent = config.safetyMessage;

  const storedId = localStorage.getItem(storageKey);

  if (!storedId) {
    showRegistration();
    return;
  }

  try {
    participant = await api(`/api/participants/${storedId}`);
    showParticipantArea();
  } catch {
    localStorage.removeItem(storageKey);
    showRegistration();
  }
}

boot().catch((error) => {
  registrationError.textContent = error.message;
  showRegistration();
});
