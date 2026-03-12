const OPERATOR_STORAGE_KEY = "qso-contest-operator";

const state = {
  appReady: false,
  cloudlogAlreadyLogged: false,
  config: null,
  isSubmitting: false,
  nextSerial: 1,
  operatorStats: [],
  selectedBand: "",
  selectedOperatorCallsign: "",
  selectedStationProfileId: "",
  sentSerialLocked: true,
  lookupTimer: null,
  lastLookupValue: ""
};

const elements = {
  appStatus: document.querySelector("#app-status"),
  bandList: document.querySelector("#band-list"),
  callsignInput: document.querySelector("#callsign-input"),
  cloudlogStatus: document.querySelector("#cloudlog-status"),
  externalStatus: document.querySelector("#external-status"),
  formatStatus: document.querySelector("#format-status"),
  form: document.querySelector("#log-form"),
  formMessage: document.querySelector("#form-message"),
  backupStatus: document.querySelector("#backup-status"),
  heroTitle: document.querySelector("#hero-title"),
  lookupDetail: document.querySelector("#lookup-detail"),
  lookupProviderDisplay: document.querySelector("#lookup-provider-display"),
  nextSerialDisplay: document.querySelector("#next-serial-display"),
  operatorPodium: document.querySelector("#operator-podium"),
  operatorRestList: document.querySelector("#operator-rest-list"),
  operatorSelect: document.querySelector("#operator-select"),
  operatorSummary: document.querySelector("#operator-summary"),
  recentList: document.querySelector("#recent-list"),
  receivedSerialInput: document.querySelector("#received-serial-input"),
  sentSerialLockButton: document.querySelector("#sent-serial-lock-button"),
  sentSerialInput: document.querySelector("#sent-serial-input"),
  stationMeta: document.querySelector("#station-meta"),
  submitButton: document.querySelector("#submit-button")
};

bootstrap().catch((error) => {
  setAppStatus("Config error", "error");
  setFormMessage(error.message, "error");
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFormMessage();

  const callsign = normalizeCallsign(elements.callsignInput.value);
  const operatorCallsign = state.selectedOperatorCallsign;
  const receivedSerial = digitsOnly(elements.receivedSerialInput.value);
  const sentSerial = digitsOnly(elements.sentSerialInput.value);

  if (!callsign || !operatorCallsign || !receivedSerial || !sentSerial || !state.selectedBand) {
    setFormMessage("Operator, callsign, serials, and band are required.", "error");
    return;
  }

  if (state.cloudlogAlreadyLogged) {
    setFormMessage(`${callsign} is already logged in Cloudlog for ${state.selectedBand}.`, "error");
    return;
  }

  setSubmitting(true);

  try {
    const response = await fetch("/api/log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        callsign,
        operatorCallsign,
        receivedSerial,
        sentSerial,
        band: state.selectedBand,
        stationProfileId: state.selectedStationProfileId
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        state.cloudlogAlreadyLogged = true;
        updateSubmitAvailability();
      }
      throw new Error(payload.error || "Log failed");
    }

    state.nextSerial = payload.nextSerial;
    state.cloudlogAlreadyLogged = false;
    state.operatorStats = payload.operatorStats || [];
    renderNextSerial();
    renderBackupState(payload.backupCount, state.operatorStats, payload.backupError);
    renderRecentQsos(payload.recentQsos || []);
    elements.callsignInput.value = "";
    elements.receivedSerialInput.value = "";
    elements.sentSerialInput.value = String(state.nextSerial).padStart(state.config.serialPad, "0");
    setSentSerialLocked(true);
    resetLookup();
    setFormMessage(`Logged ${payload.callsign} on ${state.selectedBand}.`, "success");
    elements.callsignInput.focus();
  } catch (error) {
    setFormMessage(error.message, "error");
  } finally {
    setSubmitting(false);
  }
});

elements.callsignInput.addEventListener("input", () => {
  const callsign = normalizeCallsign(elements.callsignInput.value);
  elements.callsignInput.value = callsign;
  renderFormatState(callsign);
  state.cloudlogAlreadyLogged = false;
  updateSubmitAvailability();

  window.clearTimeout(state.lookupTimer);

  if (callsign.length < 3) {
    resetLookup(false);
    return;
  }

  state.lookupTimer = window.setTimeout(() => {
    lookupCallsign(callsign).catch((error) => {
      setLookupState("Cloudlog", "Error", "error");
      setExternalState("Callbooks", "Error", "error");
      elements.lookupDetail.textContent = error.message;
    });
  }, 250);
});

elements.receivedSerialInput.addEventListener("input", () => {
  elements.receivedSerialInput.value = digitsOnly(elements.receivedSerialInput.value);
});

elements.sentSerialInput.addEventListener("input", () => {
  elements.sentSerialInput.value = digitsOnly(elements.sentSerialInput.value);
});

elements.sentSerialLockButton.addEventListener("click", () => {
  setSentSerialLocked(!state.sentSerialLocked);
});

elements.operatorSelect.addEventListener("change", () => {
  state.selectedOperatorCallsign = normalizeCallsign(elements.operatorSelect.value);
  storePreferredOperator(state.selectedOperatorCallsign);
  updateSubmitAvailability();
});

async function bootstrap() {
  const response = await fetch("/api/bootstrap");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Unable to load app");
  }

  state.config = payload.config;
  state.nextSerial = payload.nextSerial || payload.config.serialStart;
  state.operatorStats = payload.operatorStats || [];
  state.selectedStationProfileId = payload.selectedStationProfileId || "";
  state.selectedBand = payload.config.bands[0] || "";

  elements.lookupProviderDisplay.textContent = payload.config.lookupProvider;
  renderBands(payload.config.bands);
  renderOperatorOptions(payload.operators || [], payload.selectedOperatorCallsign || "");
  renderBackupState(payload.backupCount || 0, state.operatorStats);
  renderNextSerial();
  renderRecentQsos(payload.recentQsos || []);
  renderHeroTitle(payload);
  renderStationMeta(payload);
  renderFormatState("");
  setSentSerialLocked(true);

  if (payload.ready) {
    state.appReady = true;
    setAppStatus("Ready", "ready");
  } else {
    state.appReady = false;
    setAppStatus("Config needed", "error");
    setFormMessage(`Missing configuration: ${payload.issues.join(", ")}`, "error");
  }

  updateSubmitAvailability();
}

function renderBands(bands) {
  elements.bandList.innerHTML = "";

  for (const band of bands) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "band-button";
    button.textContent = band;
    button.dataset.band = band;

    if (band === state.selectedBand) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => {
      state.selectedBand = band;
      state.cloudlogAlreadyLogged = false;
      updateSubmitAvailability();
      for (const sibling of elements.bandList.querySelectorAll(".band-button")) {
        sibling.classList.toggle("selected", sibling.dataset.band === band);
      }

      const callsign = normalizeCallsign(elements.callsignInput.value);
      if (callsign.length >= 3) {
        lookupCallsign(callsign).catch(() => {});
      }
    });

    elements.bandList.appendChild(button);
  }
}

function renderNextSerial() {
  const padded = String(state.nextSerial).padStart(state.config.serialPad, "0");
  elements.nextSerialDisplay.textContent = padded;
  if (!elements.sentSerialInput.value) {
    elements.sentSerialInput.value = padded;
  }
}

function renderOperatorOptions(operators, fallbackOperatorCallsign) {
  const preferredOperator = getStoredPreferredOperator();
  const availableOperators = operators.filter(Boolean);
  const selectedOperator =
    (preferredOperator && availableOperators.includes(preferredOperator) && preferredOperator) ||
    fallbackOperatorCallsign ||
    availableOperators[0] ||
    "";

  elements.operatorSelect.innerHTML = "";

  if (availableOperators.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No operator configured";
    elements.operatorSelect.appendChild(option);
    elements.operatorSelect.disabled = true;
    state.selectedOperatorCallsign = "";
    updateSubmitAvailability();
    return;
  }

  for (const operator of availableOperators) {
    const option = document.createElement("option");
    option.value = operator;
    option.textContent = operator;
    option.selected = operator === selectedOperator;
    elements.operatorSelect.appendChild(option);
  }

  elements.operatorSelect.disabled = false;
  elements.operatorSelect.value = selectedOperator;
  state.selectedOperatorCallsign = selectedOperator;
  storePreferredOperator(selectedOperator);
  updateSubmitAvailability();
}

function renderRecentQsos(qsos) {
  elements.recentList.innerHTML = "";

  if (!qsos.length) {
    const item = document.createElement("li");
    item.className = "recent-empty";
    item.textContent = "No recent QSOs returned by Cloudlog yet.";
    elements.recentList.appendChild(item);
    return;
  }

  for (const qso of qsos) {
    const item = document.createElement("li");
    item.className = "recent-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(qso.callsign || "")}</strong>
        <span>${escapeHtml(qso.band || "")}</span>
      </div>
      <div>
        <span>${escapeHtml(qso.stx_string || "---")}</span>
        <span>${escapeHtml(qso.time || "")}</span>
      </div>
    `;
    elements.recentList.appendChild(item);
  }
}

function renderBackupState(backupCount, operatorStats, backupError = "") {
  const count = Number.isFinite(backupCount) ? backupCount : 0;
  elements.backupStatus.textContent = `${count} QSOs saved`;
  state.operatorStats = Array.isArray(operatorStats) ? operatorStats : [];
  renderOperatorStats(state.operatorStats, backupError);
}

function renderOperatorStats(operatorStats, backupError = "") {
  elements.operatorPodium.innerHTML = "";
  elements.operatorRestList.innerHTML = "";

  if (!operatorStats.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "operator-stat-empty";
    emptyState.textContent = backupError || "Podium will appear as soon as the first local backup is written.";
    elements.operatorPodium.appendChild(emptyState);
    elements.operatorSummary.textContent = backupError || "No operator activity recorded yet.";
    return;
  }

  const podium = operatorStats.slice(0, 3);
  const remainingOperators = operatorStats.slice(3);
  elements.operatorSummary.textContent = "Top operators from the local backup log.";

  for (const [index, operator] of podium.entries()) {
    const item = document.createElement("article");
    item.className = `operator-podium-card place-${index + 1}`;
    item.innerHTML = `
      <span class="operator-podium-rank">#${escapeHtml(String(index + 1))}</span>
      <strong>${escapeHtml(operator.callsign)}</strong>
      <span>${escapeHtml(String(operator.contacts))} QSOs</span>
    `;
    elements.operatorPodium.appendChild(item);
  }

  for (const operator of remainingOperators) {
    const item = document.createElement("li");
    item.className = "operator-rest-item";
    item.innerHTML = `
      <strong>${escapeHtml(operator.callsign)}</strong>
      <span>${escapeHtml(String(operator.contacts))}</span>
    `;
    elements.operatorRestList.appendChild(item);
  }

  if (backupError) {
    const item = document.createElement("li");
    item.className = "operator-stat-empty";
    item.textContent = backupError;
    elements.operatorRestList.appendChild(item);
  }
}

function renderStationMeta(payload) {
  if (payload.stationError) {
    elements.stationMeta.textContent = payload.stationError;
    return;
  }

  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  const selected = stations.find((station) => `${station.station_id}` === state.selectedStationProfileId);
  const publicLogbookSlug = payload.config?.publicLogbookSlug || "";
  const publicLogbookUrl = payload.config?.publicLogbookUrl || "";
  const publicLogbookHtml =
    publicLogbookSlug && publicLogbookUrl
      ? `<br>Public logbook: <a href="${escapeHtml(publicLogbookUrl)}" target="_blank" rel="noreferrer">${escapeHtml(publicLogbookSlug)}</a>`
      : publicLogbookSlug
        ? `<br>Public logbook: ${escapeHtml(publicLogbookSlug)}`
        : "";

  if (selected) {
    elements.stationMeta.innerHTML = `Station: ${escapeHtml(selected.station_profile_name)} (${escapeHtml(selected.station_callsign)})${publicLogbookHtml}`;
    return;
  }

  elements.stationMeta.innerHTML = `Station profile will be resolved from Cloudlog on submit.${publicLogbookHtml}`;
}

function renderHeroTitle(payload) {
  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  const selected = stations.find((station) => `${station.station_id}` === state.selectedStationProfileId);

  elements.heroTitle.textContent = selected?.station_callsign
    ? `Keep it up, ${selected.station_callsign} !`
    : "Keep it up !";
}

async function lookupCallsign(callsign) {
  state.lastLookupValue = callsign;
  setLookupState("Cloudlog", "Checking", "pending");
  setExternalState("Callbooks", "Checking", "pending");
  elements.lookupDetail.textContent = "Looking up callsign...";

  const response = await fetch(`/api/lookup?callsign=${encodeURIComponent(callsign)}&band=${encodeURIComponent(state.selectedBand)}`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Lookup failed");
  }

  if (payload.cloudlog) {
    if (payload.cloudlog.ok) {
      const cloudlogResult = `${payload.cloudlog.raw?.result || ""}`.trim().toLowerCase();
      const alreadyLogged = cloudlogResult === "found";
      state.cloudlogAlreadyLogged = alreadyLogged;
      updateSubmitAvailability();

      setLookupState(
        "Cloudlog",
        alreadyLogged ? "Already logged" : "New",
        alreadyLogged ? "warn" : "ready"
      );
    } else {
      state.cloudlogAlreadyLogged = false;
      updateSubmitAvailability();
      setLookupState("Cloudlog", "Unavailable", "error");
    }
  }

  if (payload.external) {
    if (payload.external.ok && payload.external.found !== false) {
      setExternalState("Callbooks", "Found", "ready");
    } else if (payload.external.ok && payload.external.found === false) {
      setExternalState("Callbooks", "Not found", "warn");
    } else {
      setExternalState("Callbooks", "Unavailable", "error");
    }
  }

  const detailParts = [];
  if (payload.external?.details?.name) detailParts.push(payload.external.details.name);
  if (payload.external?.details?.country) detailParts.push(payload.external.details.country);
  if (payload.external?.details?.grid) detailParts.push(`Grid ${payload.external.details.grid}`);
  if (Array.isArray(payload.external?.warnings)) detailParts.push(...payload.external.warnings);
  if (detailParts.length === 0) {
    detailParts.push(payload.external?.message || payload.cloudlog?.message || "Lookup complete.");
  }

  elements.lookupDetail.textContent = detailParts.join(" · ");
}

function renderFormatState(callsign) {
  if (!callsign) {
    updateLookupCell(elements.formatStatus, "Waiting", "pending");
    return;
  }

  const valid = /^[A-Z0-9/]{3,}$/.test(callsign);
  updateLookupCell(elements.formatStatus, valid ? "Valid" : "Check", valid ? "ready" : "warn");
}

function resetLookup(resetValue = true) {
  state.cloudlogAlreadyLogged = false;
  setLookupState("Cloudlog", "Waiting", "pending");
  setExternalState("Callbooks", "Waiting", "pending");
  elements.lookupDetail.textContent = "Type a callsign to start live lookup.";
  if (resetValue) {
    state.lastLookupValue = "";
  }
  updateSubmitAvailability();
}

function setLookupState(_label, value, tone) {
  updateLookupCell(elements.cloudlogStatus, value, tone);
}

function setExternalState(_label, value, tone) {
  updateLookupCell(elements.externalStatus, value, tone);
}

function updateLookupCell(element, text, tone) {
  element.textContent = text;
  element.dataset.tone = tone;
}

function setAppStatus(text, tone) {
  elements.appStatus.textContent = text;
  elements.appStatus.dataset.tone = tone;
}

function setFormMessage(message, tone) {
  elements.formMessage.textContent = message;
  elements.formMessage.dataset.tone = tone;
}

function clearFormMessage() {
  elements.formMessage.textContent = "";
  elements.formMessage.dataset.tone = "";
}

function setSubmitting(isSubmitting) {
  state.isSubmitting = isSubmitting;
  updateSubmitAvailability();
}

function setSentSerialLocked(isLocked) {
  state.sentSerialLocked = isLocked;
  elements.sentSerialInput.readOnly = isLocked;
  elements.sentSerialInput.dataset.locked = String(isLocked);
  elements.sentSerialInput.setAttribute("aria-readonly", String(isLocked));
  elements.sentSerialLockButton.textContent = isLocked ? "Locked" : "Unlocked";
  elements.sentSerialLockButton.dataset.locked = String(isLocked);
  elements.sentSerialLockButton.setAttribute("aria-pressed", String(isLocked));

  if (!isLocked) {
    elements.sentSerialInput.focus();
    elements.sentSerialInput.select();
  }
}

function updateSubmitAvailability() {
  elements.submitButton.disabled =
    state.isSubmitting ||
    !state.appReady ||
    state.cloudlogAlreadyLogged ||
    !state.selectedOperatorCallsign;

  if (state.isSubmitting) {
    elements.submitButton.textContent = "Logging...";
    return;
  }

  if (!state.selectedOperatorCallsign) {
    elements.submitButton.textContent = "Pick operator";
    return;
  }

  elements.submitButton.textContent = state.cloudlogAlreadyLogged ? "Already logged" : "Log QSO";
}

function normalizeCallsign(value) {
  return value.toUpperCase().replace(/\s+/g, "").trim();
}

function digitsOnly(value) {
  return value.replace(/\D+/g, "");
}

function escapeHtml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getStoredPreferredOperator() {
  try {
    return normalizeCallsign(window.localStorage.getItem(OPERATOR_STORAGE_KEY) || "");
  } catch (_error) {
    return "";
  }
}

function storePreferredOperator(operatorCallsign) {
  try {
    if (operatorCallsign) {
      window.localStorage.setItem(OPERATOR_STORAGE_KEY, operatorCallsign);
    }
  } catch (_error) {
    // Ignore storage failures and keep the in-memory value.
  }
}
