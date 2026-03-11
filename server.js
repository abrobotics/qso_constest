const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ENV_PATH = path.join(ROOT, ".env");

loadEnvFile(ENV_PATH);

const config = {
  port: Number.parseInt(process.env.PORT || "3000", 10),
  cloudlogBaseUrl: normalizeBaseUrl(process.env.CLOUDLOG_BASE_URL || ""),
  cloudlogApiKey: process.env.CLOUDLOG_API_KEY || "",
  cloudlogLogbookSlug: process.env.CLOUDLOG_LOGBOOK_PUBLIC_SLUG || "",
  cloudlogStationProfileId: process.env.CLOUDLOG_STATION_PROFILE_ID || "",
  defaultMode: (process.env.DEFAULT_MODE || "SSB").trim().toUpperCase(),
  defaultRstSent: (process.env.DEFAULT_RST_SENT || "59").trim(),
  defaultRstRcvd: (process.env.DEFAULT_RST_RCVD || "59").trim(),
  serialStart: Number.parseInt(process.env.SERIAL_START || "1", 10),
  serialPad: Math.max(1, Number.parseInt(process.env.SERIAL_PAD || "3", 10)),
  bands: (process.env.BANDS || "160m,80m,40m,20m,15m,10m")
    .split(",")
    .map((band) => band.trim())
    .filter(Boolean),
  callsignLookupProvider: (process.env.CALLSIGN_LOOKUP_PROVIDER || "hamdb").trim().toLowerCase()
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      return handleBootstrap(req, res);
    }

    if (url.pathname === "/api/lookup" && req.method === "GET") {
      return handleLookup(req, res, url);
    }

    if (url.pathname === "/api/log" && req.method === "POST") {
      return handleLog(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(req, res, url.pathname);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(config.port, () => {
  console.log(`QSO contest app listening on http://localhost:${config.port}`);
});

async function handleBootstrap(_req, res) {
  const issues = validateBaseConfig();
  const payload = {
    ready: issues.length === 0,
    issues,
    config: {
      bands: config.bands,
      defaultMode: config.defaultMode,
      defaultRstSent: config.defaultRstSent,
      defaultRstRcvd: config.defaultRstRcvd,
      serialStart: config.serialStart,
      serialPad: config.serialPad,
      lookupProvider: config.callsignLookupProvider
    }
  };

  if (issues.length > 0) {
    return sendJson(res, 200, payload);
  }

  const [stationsResult, recentResult] = await Promise.allSettled([
    fetchStationProfiles(),
    fetchRecentQsos(20)
  ]);

  if (stationsResult.status === "fulfilled") {
    payload.stations = stationsResult.value;
  } else {
    payload.stationError = stationsResult.reason.message;
  }

  if (recentResult.status === "fulfilled") {
    payload.recentQsos = recentResult.value;
    payload.nextSerial = computeNextSerial(recentResult.value, config.serialStart);
  } else {
    payload.recentError = recentResult.reason.message;
    payload.nextSerial = config.serialStart;
  }

  payload.selectedStationProfileId = pickStationProfileId(payload.stations || []);
  return sendJson(res, 200, payload);
}

async function handleLookup(_req, res, url) {
  const callsign = normalizeCallsign(url.searchParams.get("callsign") || "");
  const band = (url.searchParams.get("band") || "").trim();

  if (!callsign) {
    return sendJson(res, 400, { error: "Missing callsign" });
  }

  const issues = validateBaseConfig();
  const canUseCloudlog = issues.length === 0;

  const [cloudlogResult, lookupResult] = await Promise.allSettled([
    canUseCloudlog ? checkCloudlogCallsign(callsign, band) : Promise.resolve(null),
    lookupCallsign(callsign)
  ]);

  const response = {
    callsign,
    cloudlog: null,
    external: null
  };

  if (cloudlogResult.status === "fulfilled") {
    response.cloudlog = summarizeCloudlogLookup(cloudlogResult.value);
  } else if (cloudlogResult.status === "rejected") {
    response.cloudlog = { ok: false, message: cloudlogResult.reason.message };
  }

  if (lookupResult.status === "fulfilled") {
    response.external = lookupResult.value;
  } else {
    response.external = { provider: config.callsignLookupProvider, ok: false, message: lookupResult.reason.message };
  }

  return sendJson(res, 200, response);
}

async function handleLog(req, res) {
  const issues = validateBaseConfig();
  if (issues.length > 0) {
    return sendJson(res, 400, { error: "Missing required configuration", issues });
  }

  const body = await readJson(req);
  const callsign = normalizeCallsign(body.callsign || "");
  const band = (body.band || "").trim();
  const receivedSerial = `${body.receivedSerial || ""}`.trim();
  const sentSerialValue = Number.parseInt(`${body.sentSerial || ""}`, 10);
  const stationProfileId = `${body.stationProfileId || ""}`.trim() || pickStationProfileId(await fetchStationProfiles());

  if (!callsign || !band || !receivedSerial || !Number.isFinite(sentSerialValue) || !stationProfileId) {
    return sendJson(res, 400, { error: "Callsign, band, serials, and station profile are required" });
  }

  const sentSerial = String(sentSerialValue).padStart(config.serialPad, "0");
  const receivedSerialString = receivedSerial.padStart(config.serialPad, "0");
  const now = new Date();
  const qsoDate = formatUtcDate(now);
  const timeOn = formatUtcTime(now);
  const adif = buildAdifRecord({
    call: callsign,
    band,
    mode: config.defaultMode,
    qso_date: qsoDate,
    time_on: timeOn,
    time_off: timeOn,
    rst_sent: config.defaultRstSent,
    rst_rcvd: config.defaultRstRcvd,
    stx: String(sentSerialValue),
    stx_string: sentSerial,
    srx: stripLeadingZeros(receivedSerialString),
    srx_string: receivedSerialString
  });

  const cloudlogResponse = await postCloudlog("qso", {
    key: config.cloudlogApiKey,
    station_profile_id: stationProfileId,
    type: "adif",
    string: adif
  });

  const recent = await fetchRecentQsos(20).catch(() => []);
  return sendJson(res, 200, {
    ok: true,
    callsign,
    sentSerial,
    cloudlogResponse,
    nextSerial: sentSerialValue + 1,
    recentQsos: recent
  });
}

async function serveStatic(_req, res, pathname) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(res, 404, { error: "Not found" });
    }
    throw error;
  }
}

function validateBaseConfig() {
  const issues = [];

  if (!config.cloudlogBaseUrl) issues.push("CLOUDLOG_BASE_URL");
  if (!config.cloudlogApiKey) issues.push("CLOUDLOG_API_KEY");
  if (!config.cloudlogLogbookSlug) issues.push("CLOUDLOG_LOGBOOK_PUBLIC_SLUG");

  return issues;
}

function pickStationProfileId(stations) {
  if (config.cloudlogStationProfileId) {
    return config.cloudlogStationProfileId;
  }

  const activeStation = Array.isArray(stations)
    ? stations.find((station) => `${station.station_active || ""}` === "1")
    : null;

  return activeStation ? `${activeStation.station_id}` : "";
}

async function fetchStationProfiles() {
  const endpoint = buildCloudlogUrl(`station_info/${encodeURIComponent(config.cloudlogApiKey)}`);
  const response = await fetch(endpoint);
  return parseJsonResponse(response, "Unable to fetch station profiles");
}

async function fetchRecentQsos(limit) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(`${limit}`, 10) || 10));
  const endpoint = buildCloudlogUrl(`recent_qsos/${encodeURIComponent(config.cloudlogLogbookSlug)}/${safeLimit}`);
  const response = await fetch(endpoint);
  const data = await parseJsonResponse(response, "Unable to fetch recent QSOs");
  return normalizeRecentQsoList(data);
}

async function checkCloudlogCallsign(callsign, band) {
  return postCloudlog("logbook_check_callsign", {
    key: config.cloudlogApiKey,
    logbook_public_slug: config.cloudlogLogbookSlug,
    band: band || undefined,
    callsign
  });
}

async function lookupCallsign(callsign) {
  if (config.callsignLookupProvider === "none") {
    return { provider: "none", ok: false, message: "External lookup disabled" };
  }

  if (config.callsignLookupProvider === "hamdb") {
    const endpoint = `https://api.hamdb.org/${encodeURIComponent(callsign)}/json/qso_constest`;
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "qso-constest/0.1.0"
      }
    });
    const data = await parseJsonResponse(response, "HamDB lookup failed");
    const result = data.hamdb || data;
    const status = `${result.messages?.status || ""}`.toUpperCase();

    if (status === "NOT_FOUND") {
      return { provider: "hamdb", ok: true, found: false, message: "Callsign not found in HamDB" };
    }

    return {
      provider: "hamdb",
      ok: true,
      found: true,
      message: "Callsign found in HamDB",
      details: {
        callsign: result.callsign?.call || callsign,
        name: [result.callsign?.fname, result.callsign?.name].filter(Boolean).join(" ").trim(),
        grid: result.callsign?.grid,
        country: result.callsign?.country,
        class: result.callsign?.class
      }
    };
  }

  return {
    provider: config.callsignLookupProvider,
    ok: false,
    message: `Unsupported lookup provider: ${config.callsignLookupProvider}`
  };
}

async function postCloudlog(pathname, payload) {
  const endpoint = buildCloudlogUrl(pathname);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  return parseJsonResponse(response, `Cloudlog request failed for ${pathname}`);
}

async function parseJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.raw ||
      `${fallbackMessage} (${response.status})`;
    throw new Error(message);
  }

  return data;
}

function summarizeCloudlogLookup(data) {
  if (data == null) {
    return null;
  }

  if (typeof data === "boolean") {
    return {
      ok: true,
      workedBefore: data,
      message: data ? "Worked before in Cloudlog" : "No match found in Cloudlog"
    };
  }

  if (Array.isArray(data)) {
    return {
      ok: true,
      workedBefore: data.length > 0,
      count: data.length,
      message: data.length > 0 ? "Worked before in Cloudlog" : "No match found in Cloudlog",
      raw: data
    };
  }

  if (typeof data === "object") {
    const workedBefore =
      Boolean(data.result) ||
      Boolean(data.found) ||
      data.status === "found" ||
      Array.isArray(data.matches) ||
      Number(data.count || 0) > 0;

    return {
      ok: true,
      workedBefore,
      count: Number(data.count || 0) || undefined,
      message:
        data.message ||
        (workedBefore ? "Worked before in Cloudlog" : "No match found in Cloudlog"),
      raw: data
    };
  }

  return {
    ok: true,
    workedBefore: false,
    message: "Cloudlog lookup completed",
    raw: data
  };
}

function normalizeRecentQsoList(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.qsos)) {
    return data.qsos;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  return [];
}

function computeNextSerial(qsos, serialStart) {
  if (!Array.isArray(qsos) || qsos.length === 0) {
    return serialStart;
  }

  const serials = qsos
    .map((qso) => Number.parseInt(`${qso.stx_string || qso.stx || ""}`, 10))
    .filter((value) => Number.isFinite(value));

  if (serials.length === 0) {
    return serialStart;
  }

  return Math.max(...serials, serialStart - 1) + 1;
}

function buildAdifRecord(fields) {
  const adif = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && `${value}` !== "")
    .map(([name, value]) => {
      const stringValue = `${value}`;
      return `<${name}:${stringValue.length}>${stringValue}`;
    })
    .join("");

  return `${adif}<eor>`;
}

function formatUtcDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("");
}

function formatUtcTime(date) {
  return [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("");
}

function stripLeadingZeros(value) {
  return value.replace(/^0+(?=\d)/, "");
}

function normalizeCallsign(value) {
  return `${value}`.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeBaseUrl(value) {
  const trimmed = `${value}`.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (trimmed.endsWith("/index.php")) {
    return trimmed.slice(0, -"/index.php".length);
  }

  return trimmed;
}

function buildCloudlogUrl(pathname) {
  return `${config.cloudlogBaseUrl}/index.php/api/${pathname}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const payload = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(payload);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

function loadEnvFile(filePath) {
  try {
    const raw = require("fs").readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
