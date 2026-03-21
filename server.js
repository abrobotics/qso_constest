const http = require("http");
const os = require("os");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ENV_PATH = path.join(ROOT, ".env");

loadEnvFile(ENV_PATH);

const config = {
  host: (process.env.HOST || "0.0.0.0").trim(),
  port: Number.parseInt(process.env.PORT || "8001", 10),
  backupLogFile: resolveWorkspacePath(process.env.BACKUP_LOG_FILE || "data/qso-backup.ndjson"),
  cloudlogBaseUrl: normalizeBaseUrl(process.env.CLOUDLOG_BASE_URL || ""),
  cloudlogApiKey: process.env.CLOUDLOG_API_KEY || "",
  cloudlogLogbookSlug: process.env.CLOUDLOG_LOGBOOK_PUBLIC_SLUG || "",
  cloudlogStationProfileId: process.env.CLOUDLOG_STATION_PROFILE_ID || "",
  contestId: `${process.env.CONTEST_ID || ""}`.trim(),
  defaultMode: (process.env.DEFAULT_MODE || "SSB").trim().toUpperCase(),
  defaultOperatorCallsign: normalizeCallsign(process.env.DEFAULT_OPERATOR_CALLSIGN || ""),
  defaultRstSent: (process.env.DEFAULT_RST_SENT || "59").trim(),
  defaultRstRcvd: (process.env.DEFAULT_RST_RCVD || "59").trim(),
  operatorCallsigns: (process.env.OPERATORS || "")
    .split(",")
    .map((callsign) => normalizeCallsign(callsign))
    .filter(Boolean),
  serialStart: Number.parseInt(process.env.SERIAL_START || "1", 10),
  serialPad: Math.max(1, Number.parseInt(process.env.SERIAL_PAD || "3", 10)),
  bands: (process.env.BANDS || "160m,80m,40m,20m,15m,10m")
    .split(",")
    .map((band) => band.trim())
    .filter(Boolean),
  qrzAgent: (process.env.QRZ_AGENT || "qso_constest/0.1.0").trim(),
  qrzPassword: process.env.QRZ_PASSWORD || "",
  qrzUsername: process.env.QRZ_USERNAME || ""
};

const qrzSession = {
  key: "",
  lastError: "",
  username: ""
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

server.listen(config.port, config.host, () => {
  for (const url of buildListenUrls(config.host, config.port)) {
    console.log(`QSO contest app listening on ${url}`);
  }
});

async function handleBootstrap(_req, res) {
  const issues = validateBaseConfig();
  const backupState = await readBackupState();
  const payload = {
    ready: issues.length === 0,
    issues,
    config: {
      bands: config.bands,
      backupFile: path.basename(config.backupLogFile),
      defaultMode: config.defaultMode,
      defaultRstSent: config.defaultRstSent,
      defaultRstRcvd: config.defaultRstRcvd,
      contestId: config.contestId,
      publicLogbookSlug: config.cloudlogLogbookSlug,
      publicLogbookUrl: buildPublicLogbookUrl(),
      serialStart: config.serialStart,
      serialPad: config.serialPad,
      lookupProvider: "qrz, hamdb"
    },
    backupCount: backupState.entries.length,
    operatorStats: backupState.operatorStats,
    operators: resolveOperatorChoices([], backupState, []),
    selectedOperatorCallsign: pickDefaultOperatorCallsign(resolveOperatorChoices([], backupState, []))
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
  payload.operators = resolveOperatorChoices(payload.stations || [], backupState, payload.recentQsos || []);
  payload.selectedOperatorCallsign = pickDefaultOperatorCallsign(payload.operators);
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
    response.external = { provider: "combined", ok: false, message: lookupResult.reason.message };
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
  const operatorCallsign = normalizeCallsign(body.operatorCallsign || "");
  const receivedSerial = `${body.receivedSerial || ""}`.trim();
  const sentSerialValue = Number.parseInt(`${body.sentSerial || ""}`, 10);
  const stationProfileId = `${body.stationProfileId || ""}`.trim() || pickStationProfileId(await fetchStationProfiles());

  if (!callsign || !band || !operatorCallsign || !receivedSerial || !Number.isFinite(sentSerialValue) || !stationProfileId) {
    return sendJson(res, 400, { error: "Operator, callsign, band, serials, and station profile are required" });
  }

  const duplicateCheck = await checkCloudlogCallsign(callsign, band);
  if (isCloudlogAlreadyLogged(duplicateCheck)) {
    return sendJson(res, 409, {
      error: `${callsign} is already logged in Cloudlog for ${band}.`,
      cloudlog: summarizeCloudlogLookup(duplicateCheck)
    });
  }

  const sentSerial = String(sentSerialValue).padStart(config.serialPad, "0");
  const receivedSerialString = receivedSerial.padStart(config.serialPad, "0");
  const now = new Date();
  const qsoDate = formatUtcDate(now);
  const timeOn = formatUtcTime(now);
  const adif = buildAdifRecord({
    call: callsign,
    band,
    contest_id: config.contestId,
    mode: config.defaultMode,
    operator: operatorCallsign,
    qso_date: qsoDate,
    time_on: timeOn,
    time_off: timeOn,
    rst_sent: config.defaultRstSent,
    rst_rcvd: config.defaultRstRcvd,
    stx: String(sentSerialValue),
    srx: stripLeadingZeros(receivedSerialString)
  });

  const cloudlogResponse = await postCloudlog("qso", {
    key: config.cloudlogApiKey,
    station_profile_id: stationProfileId,
    type: "adif",
    string: adif
  });

  const backupRecord = {
    loggedAt: now.toISOString(),
    operatorCallsign,
    callsign,
    band,
    receivedSerial: receivedSerialString,
    sentSerial,
    stationProfileId,
    qsoDate,
    timeOn,
    cloudlogResponse
  };
  const backupError = await appendBackupRecord(backupRecord)
    .then(() => "")
    .catch((error) => error.message);

  const [recent, backupState] = await Promise.all([
    fetchRecentQsos(20).catch(() => []),
    readBackupState()
  ]);

  return sendJson(res, 200, {
    ok: true,
    callsign,
    operatorCallsign,
    sentSerial,
    backupCount: backupState.entries.length,
    backupError: backupError || undefined,
    cloudlogResponse,
    nextSerial: sentSerialValue + 1,
    operatorStats: backupState.operatorStats,
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

function resolveOperatorChoices(stations, backupState, recentQsos) {
  const operatorChoices = new Set(config.operatorCallsigns);

  if (config.defaultOperatorCallsign) {
    operatorChoices.add(config.defaultOperatorCallsign);
  }

  if (Array.isArray(stations)) {
    for (const station of stations) {
      const stationCallsign = normalizeCallsign(station.station_callsign || "");
      if (stationCallsign) {
        operatorChoices.add(stationCallsign);
      }
    }
  }

  if (Array.isArray(backupState?.operatorStats)) {
    for (const operator of backupState.operatorStats) {
      if (operator.callsign) {
        operatorChoices.add(operator.callsign);
      }
    }
  }

  if (Array.isArray(recentQsos)) {
    for (const qso of recentQsos) {
      const operatorCallsign = normalizeCallsign(qso.operator || "");
      if (operatorCallsign) {
        operatorChoices.add(operatorCallsign);
      }
    }
  }

  return Array.from(operatorChoices).sort();
}

function pickDefaultOperatorCallsign(operatorChoices) {
  if (config.defaultOperatorCallsign && operatorChoices.includes(config.defaultOperatorCallsign)) {
    return config.defaultOperatorCallsign;
  }

  if (config.operatorCallsigns.length > 0) {
    return config.operatorCallsigns[0];
  }

  return operatorChoices[0] || "";
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

async function readBackupState() {
  try {
    const raw = await fs.readFile(config.backupLogFile, "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch (_error) {
          return [];
        }
      });

    return {
      entries,
      operatorStats: buildOperatorStats(entries)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        entries: [],
        operatorStats: []
      };
    }

    throw error;
  }
}

async function appendBackupRecord(record) {
  await fs.mkdir(path.dirname(config.backupLogFile), { recursive: true });
  await fs.appendFile(config.backupLogFile, `${JSON.stringify(record)}\n`, "utf8");
}

function buildOperatorStats(entries) {
  const counts = new Map();

  for (const entry of entries) {
    const operatorCallsign = normalizeCallsign(entry.operatorCallsign || "");
    if (!operatorCallsign) {
      continue;
    }

    counts.set(operatorCallsign, (counts.get(operatorCallsign) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([callsign, contacts]) => ({ callsign, contacts }))
    .sort((left, right) => right.contacts - left.contacts || left.callsign.localeCompare(right.callsign));
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
  const [hamdbResult, qrzResult] = await Promise.all([
    lookupHamdbCallsignSafe(callsign),
    lookupQrzCallsignSafe(callsign)
  ]);

  return combineLookupResults([hamdbResult, qrzResult], callsign);
}

async function lookupHamdbCallsignSafe(callsign) {
  return lookupCallsignCandidates(callsign, "hamdb", (candidate) => lookupHamdbCallsign(candidate));
}

async function lookupHamdbCallsign(callsign) {
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

async function lookupQrzCallsignSafe(callsign) {
  if (!config.qrzUsername || !config.qrzPassword) {
    return {
      provider: "qrz",
      ok: false,
      found: false,
      skipped: true,
      message: "QRZ credentials not configured"
    };
  }

  return lookupCallsignCandidates(callsign, "qrz", (candidate) => lookupQrzCallsign(candidate));
}

async function lookupCallsignCandidates(callsign, provider, lookupFn) {
  const candidates = buildLookupCandidates(callsign);
  let fallbackResult = null;
  let firstError = null;

  for (const candidate of candidates) {
    try {
      const result = await lookupFn(candidate);
      if (result.found === true) {
        return {
          ...result,
          queriedCallsign: callsign,
          lookedUpCallsign: candidate
        };
      }

      if (!fallbackResult) {
        fallbackResult = {
          ...result,
          queriedCallsign: callsign,
          lookedUpCallsign: candidate
        };
      }
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  if (fallbackResult) {
    return fallbackResult;
  }

  return {
    provider,
    ok: false,
    found: false,
    message: firstError ? firstError.message : `${provider.toUpperCase()} lookup failed`
  };
}

function buildLookupCandidates(callsign) {
  const normalizedCallsign = normalizeCallsign(callsign);
  const candidates = [normalizedCallsign];

  for (const part of normalizedCallsign.split("/")) {
    const candidate = normalizeCallsign(part);
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates;
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

async function lookupQrzCallsign(callsign) {
  let sessionKey = await getQrzSessionKey();
  let data = await fetchQrzCallsign(sessionKey, callsign);

  if (isQrzSessionExpired(data.session?.error)) {
    sessionKey = await getQrzSessionKey(true);
    data = await fetchQrzCallsign(sessionKey, callsign);
  }

  if (data.session?.error) {
    const message = data.session.error;
    if (isQrzNotFound(message)) {
      return {
        provider: "qrz",
        ok: true,
        found: false,
        message: "Callsign not found in QRZ",
        details: {
          callsign
        }
      };
    }

    throw new Error(message);
  }

  if (!data.callsign) {
    return {
      provider: "qrz",
      ok: true,
      found: false,
      message: "Callsign not found in QRZ",
      details: {
        callsign
      }
    };
  }

  return {
    provider: "qrz",
    ok: true,
    found: true,
    message: "Callsign found in QRZ",
    details: {
      callsign: data.callsign.call || callsign,
      name: [data.callsign.fname, data.callsign.name].filter(Boolean).join(" ").trim(),
      grid: data.callsign.grid,
      country: data.callsign.country,
      class: data.callsign.class,
      state: data.callsign.state,
      county: data.callsign.county
    }
  };
}

function combineLookupResults(results, callsign) {
  const successfulResults = results.filter((result) => result?.ok);
  const foundResults = successfulResults.filter((result) => result.found === true);
  const preferredDetailsResult =
    foundResults.find((result) => result.provider === "qrz") ||
    foundResults.find((result) => result.provider === "hamdb") ||
    successfulResults.find((result) => result.provider === "qrz" && result.details) ||
    successfulResults.find((result) => result.provider === "hamdb" && result.details) ||
    null;
  const warnings = results
    .filter((result) => result && !result.ok)
    .map((result) => `${result.provider.toUpperCase()}: ${result.message}`);

  if (successfulResults.length === 0) {
    return {
      provider: "combined",
      ok: false,
      found: false,
      message: "No callsign lookup providers available",
      details: { callsign },
      warnings,
      providers: mapLookupProviders(results)
    };
  }

  if (foundResults.length > 0) {
    return {
      provider: "combined",
      ok: true,
      found: true,
      message: `Callsign found in ${foundResults.map((result) => result.provider.toUpperCase()).join(" + ")}`,
      details: preferredDetailsResult?.details || { callsign },
      warnings,
      providers: mapLookupProviders(results)
    };
  }

  return {
    provider: "combined",
    ok: true,
    found: false,
    message: "Callsign not found in available callbooks",
    details: preferredDetailsResult?.details || { callsign },
    warnings,
    providers: mapLookupProviders(results)
  };
}

function mapLookupProviders(results) {
  return Object.fromEntries(
    results
      .filter(Boolean)
      .map((result) => [result.provider, result])
  );
}

async function getQrzSessionKey(forceRefresh = false) {
  if (
    !forceRefresh &&
    qrzSession.key &&
    qrzSession.username === config.qrzUsername
  ) {
    return qrzSession.key;
  }

  const endpoint = buildQrzUrl({
    username: config.qrzUsername,
    password: config.qrzPassword,
    agent: config.qrzAgent
  });
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": config.qrzAgent
    }
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`QRZ session request failed (${response.status})`);
  }

  const data = parseQrzXml(text);
  if (!data.session?.key) {
    throw new Error(data.session?.error || "QRZ did not return a session key");
  }

  qrzSession.key = data.session.key;
  qrzSession.lastError = data.session.error || "";
  qrzSession.username = config.qrzUsername;
  return qrzSession.key;
}

async function fetchQrzCallsign(sessionKey, callsign) {
  const endpoint = buildQrzUrl({
    s: sessionKey,
    callsign
  });
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": config.qrzAgent
    }
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`QRZ callsign request failed (${response.status})`);
  }

  return parseQrzXml(text);
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
    const rawResult = `${data.result || ""}`.trim().toLowerCase();
    const workedBefore = isCloudlogAlreadyLogged(data);

    return {
      ok: true,
      workedBefore,
      count: Number(data.count || 0) || undefined,
      message:
        data.message ||
        (rawResult === "not found" ? "No match found in Cloudlog" : null) ||
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

function parseQrzXml(xml) {
  const sessionXml = extractXmlSection(xml, "Session");
  const callsignXml = extractXmlSection(xml, "Callsign");

  return {
    session: sessionXml
      ? {
          key: extractXmlValue(sessionXml, "Key"),
          error: extractXmlValue(sessionXml, "Error"),
          count: extractXmlValue(sessionXml, "Count"),
          subExp: extractXmlValue(sessionXml, "SubExp"),
          gmTime: extractXmlValue(sessionXml, "GMTime")
        }
      : null,
    callsign: callsignXml
      ? {
          call: extractXmlValue(callsignXml, "call"),
          fname: extractXmlValue(callsignXml, "fname"),
          name: extractXmlValue(callsignXml, "name"),
          addr2: extractXmlValue(callsignXml, "addr2"),
          state: extractXmlValue(callsignXml, "state"),
          county: extractXmlValue(callsignXml, "county"),
          country: extractXmlValue(callsignXml, "country"),
          grid: extractXmlValue(callsignXml, "grid"),
          class: extractXmlValue(callsignXml, "class"),
          status: extractXmlValue(callsignXml, "status")
        }
      : null
  };
}

function extractXmlSection(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? match[1] : "";
}

function extractXmlValue(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeXmlEntities(match[1].trim()) : "";
}

function decodeXmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function isQrzSessionExpired(errorMessage) {
  const normalized = `${errorMessage || ""}`.toLowerCase();
  return normalized.includes("session timeout") || normalized.includes("invalid session key");
}

function isQrzNotFound(errorMessage) {
  const normalized = `${errorMessage || ""}`.toLowerCase();
  return normalized.includes("not found");
}

function isCloudlogAlreadyLogged(data) {
  if (data == null) {
    return false;
  }

  if (typeof data === "boolean") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.length > 0;
  }

  const rawResult = `${data.result || ""}`.trim().toLowerCase();
  return (
    rawResult === "found" ||
    rawResult === "match" ||
    Boolean(data.found) ||
    data.status === "found" ||
    Array.isArray(data.matches) ||
    Number(data.count || 0) > 0
  );
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
    .map((qso) => Number.parseInt(`${qso.stx || ""}`, 10))
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

function buildPublicLogbookUrl() {
  if (!config.cloudlogBaseUrl || !config.cloudlogLogbookSlug) {
    return "";
  }

  return `${config.cloudlogBaseUrl}/index.php/visitor/${encodeURIComponent(config.cloudlogLogbookSlug)}`;
}

function buildQrzUrl(params) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && `${value}` !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(`${value}`)}`)
    .join(";");

  return `https://xmldata.qrz.com/xml/current/?${query}`;
}

function resolveWorkspacePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.join(ROOT, filePath);
}

function buildListenUrls(host, port) {
  const urls = new Set();

  if (host === "0.0.0.0" || host === "::") {
    urls.add(`http://localhost:${port}`);

    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal) {
          urls.add(`http://${entry.address}:${port}`);
        }
      }
    }
  } else {
    urls.add(`http://${host}:${port}`);
  }

  return Array.from(urls);
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
