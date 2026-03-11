const state = {
  appReady: false,
  cloudlogAlreadyLogged: false,
  config: null,
  isSubmitting: false,
  nextSerial: 1,
  selectedBand: "",
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
  lookupDetail: document.querySelector("#lookup-detail"),
  lookupProviderDisplay: document.querySelector("#lookup-provider-display"),
  nextSerialDisplay: document.querySelector("#next-serial-display"),
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
  const receivedSerial = digitsOnly(elements.receivedSerialInput.value);
  const sentSerial = digitsOnly(elements.sentSerialInput.value);

  if (!callsign || !receivedSerial || !sentSerial || !state.selectedBand) {
    setFormMessage("Callsign, serials, and band are required.", "error");
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
    renderNextSerial();
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
      setExternalState("Callbook", "Error", "error");
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

async function bootstrap() {
  const response = await fetch("/api/bootstrap");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Unable to load app");
  }

  state.config = payload.config;
  state.nextSerial = payload.nextSerial || payload.config.serialStart;
  state.selectedStationProfileId = payload.selectedStationProfileId || "";
  state.selectedBand = payload.config.bands[0] || "";

  elements.lookupProviderDisplay.textContent = payload.config.lookupProvider;
  renderBands(payload.config.bands);
  renderNextSerial();
  renderRecentQsos(payload.recentQsos || []);
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

function renderStationMeta(payload) {
  if (payload.stationError) {
    elements.stationMeta.textContent = payload.stationError;
    return;
  }

  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  const selected = stations.find((station) => `${station.station_id}` === state.selectedStationProfileId);

  if (selected) {
    elements.stationMeta.textContent = `Station: ${selected.station_profile_name} (${selected.station_callsign})`;
    return;
  }

  elements.stationMeta.textContent = "Station profile will be resolved from Cloudlog on submit.";
}

async function lookupCallsign(callsign) {
  state.lastLookupValue = callsign;
  setLookupState("Cloudlog", "Checking", "pending");
  setExternalState("Callbook", "Checking", "pending");
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
      setExternalState("Callbook", "Found", "ready");
    } else if (payload.external.ok && payload.external.found === false) {
      setExternalState("Callbook", "Not found", "warn");
    } else {
      setExternalState("Callbook", "Unavailable", "error");
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
  setExternalState("Callbook", "Waiting", "pending");
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
    state.cloudlogAlreadyLogged;

  if (state.isSubmitting) {
    elements.submitButton.textContent = "Logging...";
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
