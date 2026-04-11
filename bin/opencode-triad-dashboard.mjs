#!/home/mhugo/.nix-profile/bin/node

import http from "node:http";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3012;
const STATUS_TIMEOUT_MS = 2000;
const API_TIMEOUT_MS = 5000;
const LLM_STATS_CACHE_TTL_MS = 30000;
const LLM_STATS_FETCH_BATCH_SIZE = 4;
const EMPTY_STRING = "";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NO_STORE_CACHE_CONTROL = "no-store, max-age=0";
const BACKENDS = [
  {
    id: "aicoder",
    title: "aicoder-opencode",
    origin: "http://127.0.0.1:8080",
    role: "shared maintenance",
    directory: "/home/mhugo/code/aicoder-opencode",
  },
  {
    id: "dr",
    title: "dr-repo",
    origin: "http://127.0.0.1:8082",
    role: "product repo",
    directory: "/home/mhugo/code/dr-repo",
  },
  {
    id: "letta",
    title: "letta-workspace",
    origin: "http://127.0.0.1:8084",
    role: "product repo",
    directory: "/home/mhugo/code/letta-workspace",
  },
];

const bindHost = process.env.OPENCODE_TRIAD_DASHBOARD_HOST?.trim() || DEFAULT_HOST;
const parsedPort = Number.parseInt(process.env.OPENCODE_TRIAD_DASHBOARD_PORT ?? EMPTY_STRING, 10);
const bindPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
let llmStatsCacheValue = null;
let llmStatsCacheExpiresAt = 0;
let llmStatsCacheInFlight = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function backendById(backendID) {
  return BACKENDS.find((backend) => backend.id === backendID) ?? null;
}

function normalizeSessionList(sessions) {
  return (Array.isArray(sessions) ? sessions : []).slice(0, 20);
}

function createEmptyLlmStats() {
  return {
    loadedSessionCount: 0,
    assistantMessageCount: 0,
    providerCount: 0,
    modelCount: 0,
    toolPartCount: 0,
    reasoningPartCount: 0,
    latestRouteLabel: "none yet",
    topRouteLabel: "none yet",
  };
}

function buildRouteLabel(providerID, modelID) {
  const rawRouteLabel = [providerID, modelID].filter(Boolean).join("/");
  return rawRouteLabel || "none yet";
}

function mergeRouteCounts(targetRouteCounts, sourceRouteCounts) {
  for (const [routeLabel, routeCount] of sourceRouteCounts.entries()) {
    targetRouteCounts.set(routeLabel, (targetRouteCounts.get(routeLabel) ?? 0) + routeCount);
  }
}

function summarizeMessages(messages, loadedSessionCount) {
  const providerIDs = new Set();
  const modelIDs = new Set();
  const routeCountsByLabel = new Map();
  let assistantMessageCount = 0;
  let toolPartCount = 0;
  let reasoningPartCount = 0;
  let latestRouteLabel = "none yet";

  for (const message of Array.isArray(messages) ? messages : []) {
    const info = message?.info ?? {};
    const parts = Array.isArray(message?.parts) ? message.parts : [];

    for (const part of parts) {
      if (part?.type === "tool") {
        toolPartCount += 1;
      }
      if (part?.type === "reasoning") {
        reasoningPartCount += 1;
      }
    }

    if (info.role !== "assistant") {
      continue;
    }

    assistantMessageCount += 1;
    if (typeof info.providerID === "string" && info.providerID.trim() !== EMPTY_STRING) {
      providerIDs.add(info.providerID);
    }
    if (typeof info.modelID === "string" && info.modelID.trim() !== EMPTY_STRING) {
      modelIDs.add(info.modelID);
    }

    const routeLabel = buildRouteLabel(info.providerID, info.modelID);
    latestRouteLabel = routeLabel;
    routeCountsByLabel.set(routeLabel, (routeCountsByLabel.get(routeLabel) ?? 0) + 1);
  }

  let topRouteLabel = "none yet";
  let topRouteCount = 0;
  for (const [routeLabel, routeCount] of routeCountsByLabel.entries()) {
    if (routeCount > topRouteCount) {
      topRouteLabel = routeLabel;
      topRouteCount = routeCount;
    }
  }

  return {
    loadedSessionCount,
    assistantMessageCount,
    providerCount: providerIDs.size,
    modelCount: modelIDs.size,
    toolPartCount,
    reasoningPartCount,
    latestRouteLabel,
    topRouteLabel,
    routeCountsByLabel,
    providerIDs,
    modelIDs,
  };
}

function makePublicLlmStats(stats) {
  return {
    loadedSessionCount: stats.loadedSessionCount,
    assistantMessageCount: stats.assistantMessageCount,
    providerCount: stats.providerCount,
    modelCount: stats.modelCount,
    toolPartCount: stats.toolPartCount,
    reasoningPartCount: stats.reasoningPartCount,
    latestRouteLabel: stats.latestRouteLabel,
    topRouteLabel: stats.topRouteLabel,
  };
}

async function mapInBatches(items, batchSize, worker) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonRequest(request) {
  const text = await readRequestBody(request);
  if (text.trim() === EMPTY_STRING) {
    return {};
  }
  return JSON.parse(text);
}

async function fetchBackend(backend, requestPath, options = {}) {
  const response = await fetch(`${backend.origin}${requestPath}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    ...options,
  });
  return response;
}

async function fetchBackendJson(backend, requestPath, options = {}) {
  const response = await fetchBackend(backend, requestPath, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function probeBackend(backend) {
  try {
    const response = await fetchBackend(backend, "/", { method: "GET", timeoutMs: STATUS_TIMEOUT_MS });
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      origin: backend.origin,
      directory: backend.directory,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      origin: backend.origin,
      directory: backend.directory,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readBackendConfig(backend) {
  return fetchBackendJson(backend, "/config");
}

async function listBackendSessions(backend) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  return fetchBackendJson(backend, `/session?directory=${encodedDirectory}`);
}

async function createBackendSession(backend, title) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  const response = await fetchBackend(backend, `/session?directory=${encodedDirectory}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function deleteBackendSession(backend, sessionID) {
  const encodedSessionID = encodeURIComponent(sessionID);
  const response = await fetchBackend(backend, `/session/${encodedSessionID}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

async function readBackendMessages(backend, sessionID) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  const encodedSessionID = encodeURIComponent(sessionID);
  return fetchBackendJson(backend, `/session/${encodedSessionID}/message?directory=${encodedDirectory}`);
}

async function sendBackendMessage(backend, sessionID, text, agentName) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  const encodedSessionID = encodeURIComponent(sessionID);
  const body = {
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };

  if (agentName && agentName.trim() !== EMPTY_STRING) {
    body.agent = agentName.trim();
  }

  const response = await fetchBackend(backend, `/session/${encodedSessionID}/message?directory=${encodedDirectory}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  await response.body?.cancel().catch(() => {});
  return {
    accepted: true,
    status: response.status,
    sessionID,
    agent: body.agent ?? null,
  };
}

async function collectBackendSummary() {
  return Promise.all(
    BACKENDS.map(async (backend) => {
      const status = await probeBackend(backend);
      if (!status.ok) {
        return { ...status, sessions: [], defaultAgent: null, agentNames: [] };
      }

      try {
        const [config, sessions] = await Promise.all([readBackendConfig(backend), listBackendSessions(backend)]);
        return {
          ...status,
          defaultAgent: config.default_agent ?? null,
          agentNames: Object.keys(config.agent ?? {}),
          sessions: normalizeSessionList(sessions),
        };
      } catch (error) {
        return {
          ...status,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          sessions: [],
          defaultAgent: null,
          agentNames: [],
        };
      }
    }),
  );
}

async function collectBackendLlmStats(backend) {
  const status = await probeBackend(backend);
  if (!status.ok) {
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      ok: false,
      status: status.status,
      error: status.error ?? "backend unavailable",
      stats: createEmptyLlmStats(),
    };
  }

  try {
    const listedSessions = await listBackendSessions(backend);
    const sessions = Array.isArray(listedSessions) ? listedSessions : [];
    const sessionMessages = await mapInBatches(
      sessions,
      LLM_STATS_FETCH_BATCH_SIZE,
      async (session) => readBackendMessages(backend, session.id),
    );
    const flattenedMessages = sessionMessages.flatMap((messages) => (Array.isArray(messages) ? messages : []));
    const stats = summarizeMessages(flattenedMessages, sessions.length);
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      ok: true,
      status: status.status,
      stats: makePublicLlmStats(stats),
      _providerIDs: stats.providerIDs,
      _modelIDs: stats.modelIDs,
      _routeCountsByLabel: stats.routeCountsByLabel,
    };
  } catch (error) {
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      ok: false,
      status: status.status,
      error: error instanceof Error ? error.message : String(error),
      stats: createEmptyLlmStats(),
    };
  }
}

async function collectLlmStatsSummary() {
  const currentTimestamp = Date.now();
  if (llmStatsCacheValue && currentTimestamp < llmStatsCacheExpiresAt) {
    return llmStatsCacheValue;
  }
  if (llmStatsCacheInFlight) {
    return llmStatsCacheInFlight;
  }

  llmStatsCacheInFlight = (async () => {
    const backends = await Promise.all(BACKENDS.map((backend) => collectBackendLlmStats(backend)));
    const providerIDs = new Set();
    const modelIDs = new Set();
    const routeCountsByLabel = new Map();
    let assistantMessageCount = 0;
    let loadedSessionCount = 0;
    let toolPartCount = 0;
    let reasoningPartCount = 0;
    let latestRouteLabel = "none yet";

    for (const backend of backends) {
      assistantMessageCount += backend.stats.assistantMessageCount;
      loadedSessionCount += backend.stats.loadedSessionCount;
      toolPartCount += backend.stats.toolPartCount;
      reasoningPartCount += backend.stats.reasoningPartCount;

      if (backend.stats.latestRouteLabel !== "none yet") {
        latestRouteLabel = backend.stats.latestRouteLabel;
      }

      for (const providerID of backend._providerIDs ?? []) {
        providerIDs.add(providerID);
      }
      for (const modelID of backend._modelIDs ?? []) {
        modelIDs.add(modelID);
      }
      mergeRouteCounts(routeCountsByLabel, backend._routeCountsByLabel ?? new Map());

      delete backend._providerIDs;
      delete backend._modelIDs;
      delete backend._routeCountsByLabel;
    }

    let topRouteLabel = "none yet";
    let topRouteCount = 0;
    for (const [routeLabel, routeCount] of routeCountsByLabel.entries()) {
      if (routeCount > topRouteCount) {
        topRouteLabel = routeLabel;
        topRouteCount = routeCount;
      }
    }

    const payload = {
      generatedAt: currentTimestamp,
      cacheTtlMs: LLM_STATS_CACHE_TTL_MS,
      backends,
      total: {
        loadedSessionCount,
        assistantMessageCount,
        providerCount: providerIDs.size,
        modelCount: modelIDs.size,
        toolPartCount,
        reasoningPartCount,
        latestRouteLabel,
        topRouteLabel,
      },
    };

    llmStatsCacheValue = payload;
    llmStatsCacheExpiresAt = Date.now() + LLM_STATS_CACHE_TTL_MS;
    return payload;
  })();

  try {
    return await llmStatsCacheInFlight;
  } finally {
    llmStatsCacheInFlight = null;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    "cache-control": NO_STORE_CACHE_CONTROL,
  });
  response.end(JSON.stringify(payload, null, 2));
}

function renderDashboard() {
  const backendLiteral = JSON.stringify(BACKENDS, null, 2);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Singularity Matrix</title>
    <style>
      :root {
        --bg: #101112;
        --panel: #17191b;
        --panel-2: #1f2327;
        --line: #2e3338;
        --text: #f2f3f5;
        --muted: #9aa3ad;
        --accent: #c85a17;
        --accent-2: #e37b40;
        --ok: #7ddc7a;
        --bad: #ff7575;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(200,90,23,.18), transparent 30%),
          linear-gradient(180deg, #0c0d0e 0%, var(--bg) 100%);
        color: var(--text);
        font: 14px/1.4 "JetBrainsMono Nerd Font", "JetBrains Mono", monospace;
      }
      button, input, textarea, select, a {
        font: inherit;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto 1fr;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding: 0.9rem 1rem;
        border-bottom: 1px solid var(--line);
        background: rgba(16, 17, 18, 0.9);
        backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 20;
      }
      .topbar h1 {
        margin: 0;
        font-size: 1rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .topbar p {
        margin: 0.2rem 0 0;
        color: var(--muted);
      }
      .toolbar {
        display: flex;
        gap: 0.6rem;
      }
      button, .link-button, select, textarea, input {
        border: 1px solid var(--line);
        background: var(--panel-2);
        color: var(--text);
        padding: 0.55rem 0.8rem;
        text-decoration: none;
        border-radius: 0.5rem;
      }
      button, .link-button {
        cursor: pointer;
      }
      button:hover, .link-button:hover {
        border-color: var(--accent);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.9rem;
        padding: 0.9rem;
      }
      .card {
        display: grid;
        grid-template-rows: auto auto auto 1fr auto;
        min-height: calc(100vh - 5rem);
        background: linear-gradient(180deg, rgba(31,35,39,.95), rgba(23,25,27,.95));
        border: 1px solid var(--line);
        border-radius: 0.9rem;
        overflow: hidden;
        box-shadow: 0 14px 40px rgba(0,0,0,.28);
      }
      .card.up { border-color: rgba(125,220,122,.28); }
      .card.down { border-color: rgba(255,117,117,.28); }
      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 0.8rem;
        padding: 0.9rem;
        border-bottom: 1px solid var(--line);
      }
      .card-header h2 {
        margin: 0;
        font-size: 0.95rem;
      }
      .card-header p {
        margin: 0.2rem 0 0;
        color: var(--muted);
      }
      .status {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        white-space: nowrap;
        color: var(--muted);
      }
      .dot {
        width: 0.65rem;
        height: 0.65rem;
        border-radius: 50%;
        background: var(--line);
      }
      .dot.up { background: var(--ok); box-shadow: 0 0 14px rgba(125,220,122,.6); }
      .dot.down { background: var(--bad); box-shadow: 0 0 14px rgba(255,117,117,.5); }
      .card-actions,
      .composer {
        display: flex;
        gap: 0.55rem;
        padding: 0.75rem 0.9rem;
        border-bottom: 1px solid var(--line);
      }
      .composer {
        border-top: 1px solid var(--line);
        border-bottom: 0;
        flex-direction: column;
      }
      .composer-row {
        display: flex;
        gap: 0.55rem;
      }
      .composer textarea {
        width: 100%;
        min-height: 6rem;
        resize: vertical;
      }
      .body {
        display: grid;
        grid-template-columns: 18rem 1fr;
        min-height: 0;
      }
      .sessions {
        border-right: 1px solid var(--line);
        overflow: auto;
        min-height: 0;
      }
      .session-row {
        width: 100%;
        text-align: left;
        border: 0;
        border-bottom: 1px solid rgba(46,51,56,.65);
        border-radius: 0;
        background: transparent;
        padding: 0.8rem 0.9rem;
      }
      .session-row.active {
        background: rgba(200,90,23,.12);
      }
      .session-row strong {
        display: block;
      }
      .session-row small {
        display: block;
        color: var(--muted);
        margin-top: 0.25rem;
      }
      .session-tree {
        padding: 0.35rem 0;
      }
      .session-group {
        border-bottom: 1px solid rgba(46,51,56,.45);
      }
      .session-children {
        padding-left: 1rem;
        border-left: 1px solid rgba(46,51,56,.45);
        margin-left: 0.9rem;
      }
      .session-row.child {
        background: rgba(16,17,18,.35);
      }
      .session-label-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .session-kind {
        color: var(--accent-2);
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .messages {
        overflow: auto;
        min-height: 0;
        padding: 0.9rem;
      }
      .message {
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--line);
        border-radius: 0.75rem;
        background: rgba(16,17,18,.6);
        margin-bottom: 0.75rem;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin-bottom: 0.5rem;
        color: var(--muted);
        font-size: 0.85rem;
      }
      .message pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
      }
      .empty {
        color: var(--muted);
        padding: 1rem;
      }
      .pill {
        display: inline-block;
        padding: 0.1rem 0.45rem;
        border: 1px solid var(--line);
        border-radius: 999px;
      }
      .error {
        color: var(--bad);
      }
      @media (max-width: 1400px) {
        .grid { grid-template-columns: 1fr; }
        .card { min-height: auto; }
        .body { grid-template-columns: 1fr; }
        .sessions { border-right: 0; border-bottom: 1px solid var(--line); max-height: 18rem; }
        .messages { max-height: 60vh; }
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      const BACKENDS = ${backendLiteral};
      const POLL_MS = 10000;
      const state = {
        backends: BACKENDS.map((backend) => ({ ...backend, ok: false, sessions: [] })),
        selectedSessions: {},
        messagesByBackend: {},
        draftsByBackend: {},
        errorsByBackend: {},
        sendingByBackend: {},
        creatingByBackend: {},
      };

      function formatTimestamp(value) {
        if (!value) return "";
        try {
          return new Date(Number(value)).toLocaleTimeString();
        } catch {
          return "";
        }
      }

      function summarizeParts(parts) {
        if (!Array.isArray(parts) || parts.length === 0) return "";
        return parts.map((part) => {
          if (!part || typeof part !== "object") return "";
          if (part.type === "text") return part.text || "";
          if (part.type === "tool") return "[tool " + (part.tool || part.name || "call") + "]";
          if (part.type === "reasoning") return "[reasoning]";
          return "[" + (part.type || "part") + "]";
        }).filter(Boolean).join("\\n");
      }

      async function readJson(url, options) {
        const response = await fetch(url, { credentials: "same-origin", ...options });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      }

      function selectSession(backendID, sessionID) {
        state.selectedSessions[backendID] = sessionID;
        refreshMessages(backendID).catch((error) => {
          state.errorsByBackend[backendID] = error.message;
          render();
        });
        render();
      }

      async function refreshBackends() {
        const payload = await readJson("/api/backends");
        const nextBackends = Array.isArray(payload.backends) ? payload.backends : [];
        state.backends = nextBackends;
        for (const backend of nextBackends) {
          const selectedSessionID = state.selectedSessions[backend.id];
          if (!backend.sessions.some((session) => session.id === selectedSessionID)) {
            state.selectedSessions[backend.id] = backend.sessions[0]?.id || null;
          }
        }
        render();
        await Promise.all(nextBackends.map((backend) => refreshMessages(backend.id).catch(() => {})));
      }

      async function refreshMessages(backendID) {
        const selectedSessionID = state.selectedSessions[backendID];
        if (!selectedSessionID) {
          state.messagesByBackend[backendID] = [];
          render();
          return;
        }
        const payload = await readJson("/api/backends/" + backendID + "/sessions/" + selectedSessionID + "/messages");
        state.messagesByBackend[backendID] = Array.isArray(payload.messages) ? payload.messages.slice(-20) : [];
        render();
      }

      async function createSession(backendID) {
        state.creatingByBackend[backendID] = true;
        state.errorsByBackend[backendID] = "";
        render();
        try {
          const backend = state.backends.find((item) => item.id === backendID);
          const payload = await readJson("/api/backends/" + backendID + "/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: backend.title + " chat" }),
          });
          state.selectedSessions[backendID] = payload.session.id;
          await refreshBackends();
        } catch (error) {
          state.errorsByBackend[backendID] = error.message;
          render();
        } finally {
          state.creatingByBackend[backendID] = false;
          render();
        }
      }

      async function sendMessage(backendID) {
        const text = (state.draftsByBackend[backendID] || "").trim();
        const selectedSessionID = state.selectedSessions[backendID];
        if (!selectedSessionID || !text) return;
        state.sendingByBackend[backendID] = true;
        state.errorsByBackend[backendID] = "";
        render();
        try {
          const backend = state.backends.find((item) => item.id === backendID);
          await readJson("/api/backends/" + backendID + "/sessions/" + selectedSessionID + "/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, agent: backend.defaultAgent || "implementation_lead" }),
          });
          state.draftsByBackend[backendID] = "";
          await refreshBackends();
          await refreshMessages(backendID);
        } catch (error) {
          state.errorsByBackend[backendID] = error.message;
          render();
        } finally {
          state.sendingByBackend[backendID] = false;
          render();
        }
      }

      function renderSessionList(backend, selectedSessionID) {
        if (backend.sessions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "no sessions";
          return empty;
        }

        const container = document.createElement("div");
        container.className = "session-tree";
        const sessionsByID = new Map(backend.sessions.map((session) => [session.id, session]));
        const childSessionsByParentID = new Map();
        const rootSessions = [];

        for (const session of backend.sessions) {
          const parentID = session.parentID || null;
          if (!parentID || !sessionsByID.has(parentID)) {
            rootSessions.push(session);
            continue;
          }

          const children = childSessionsByParentID.get(parentID) || [];
          children.push(session);
          childSessionsByParentID.set(parentID, children);
        }

        function createSessionButton(session, kind) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "session-row" + (selectedSessionID === session.id ? " active" : "") + (kind === "subagent" ? " child" : "");
          button.addEventListener("click", () => selectSession(backend.id, session.id));

          const labelRow = document.createElement("div");
          labelRow.className = "session-label-row";

          const title = document.createElement("strong");
          title.textContent = session.title || session.id;
          labelRow.appendChild(title);

          const kindBadge = document.createElement("span");
          kindBadge.className = "session-kind";
          kindBadge.textContent = kind;
          labelRow.appendChild(kindBadge);

          button.appendChild(labelRow);

          const id = document.createElement("small");
          id.textContent = session.id;
          button.appendChild(id);

          const updated = document.createElement("small");
          updated.textContent = formatTimestamp(session.time?.updated);
          button.appendChild(updated);
          return button;
        }

        for (const rootSession of rootSessions) {
          const group = document.createElement("div");
          group.className = "session-group";
          group.appendChild(createSessionButton(rootSession, "main"));

          const childSessions = childSessionsByParentID.get(rootSession.id) || [];
          if (childSessions.length > 0) {
            const childrenWrapper = document.createElement("div");
            childrenWrapper.className = "session-children";
            for (const childSession of childSessions) {
              childrenWrapper.appendChild(createSessionButton(childSession, "subagent"));
            }
            group.appendChild(childrenWrapper);
          }

          container.appendChild(group);
        }
        return container;
      }

      function renderMessages(backendID, selectedSessionID) {
        const messages = state.messagesByBackend[backendID] || [];
        const wrapper = document.createElement("div");
        if (!selectedSessionID) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "select a session";
          wrapper.appendChild(empty);
          return wrapper;
        }
        if (messages.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "no messages or still loading";
          wrapper.appendChild(empty);
          return wrapper;
        }

        for (const message of messages) {
          const info = message.info || {};
          const card = document.createElement("div");
          card.className = "message";

          const meta = document.createElement("div");
          meta.className = "meta";
          for (const value of [info.role || "unknown", info.agent, info.providerID, info.modelID, info.finish]) {
            if (!value) continue;
            const span = document.createElement("span");
            if (value === (info.role || "unknown")) span.className = "pill";
            span.textContent = value;
            meta.appendChild(span);
          }
          card.appendChild(meta);

          const pre = document.createElement("pre");
          pre.textContent = summarizeParts(message.parts);
          card.appendChild(pre);

          wrapper.appendChild(card);
        }
        return wrapper;
      }

      function render() {
        const root = document.getElementById("root");
        root.innerHTML = "";

        const shell = document.createElement("div");
        shell.className = "shell";

        const topbar = document.createElement("header");
        topbar.className = "topbar";
        topbar.innerHTML = '<div><h1>Singularity Matrix</h1><p>Local control surface on top of the OpenCode JSON API</p></div>';

        const toolbar = document.createElement("div");
        toolbar.className = "toolbar";

        const reloadButton = document.createElement("button");
        reloadButton.type = "button";
        reloadButton.textContent = "reload";
        reloadButton.addEventListener("click", () => window.location.reload());
        toolbar.appendChild(reloadButton);

        const apiLink = document.createElement("a");
        apiLink.className = "link-button";
        apiLink.href = "/api/backends";
        apiLink.target = "_blank";
        apiLink.rel = "noreferrer";
        apiLink.textContent = "api";
        toolbar.appendChild(apiLink);

        topbar.appendChild(toolbar);
        shell.appendChild(topbar);

        const grid = document.createElement("main");
        grid.className = "grid";

        for (const backend of state.backends) {
          const selectedSessionID = state.selectedSessions[backend.id] || null;
          const selectedSession = backend.sessions.find((session) => session.id === selectedSessionID) || null;
          const card = document.createElement("section");
          card.className = "card " + (backend.ok ? "up" : "down");

          const header = document.createElement("header");
          header.className = "card-header";
          header.innerHTML =
            "<div><h2>" + backend.title + "</h2><p>" + backend.role + "</p></div>" +
            '<div class="status"><span class="dot ' + (backend.ok ? "up" : "down") + '"></span><span>' +
            (backend.ok ? "up " + backend.status : "down " + (backend.error || backend.status || "unreachable")) +
            "</span></div>";
          card.appendChild(header);

          const actions = document.createElement("div");
          actions.className = "card-actions";

          const openLink = document.createElement("a");
          openLink.className = "link-button";
          openLink.href = backend.origin;
          openLink.target = "_blank";
          openLink.rel = "noreferrer";
          openLink.textContent = "open";
          actions.appendChild(openLink);

          const createButton = document.createElement("button");
          createButton.type = "button";
          createButton.disabled = !!state.creatingByBackend[backend.id];
          createButton.textContent = state.creatingByBackend[backend.id] ? "creating..." : "new session";
          createButton.addEventListener("click", () => createSession(backend.id));
          actions.appendChild(createButton);

          const count = document.createElement("span");
          count.className = "pill";
          count.textContent = backend.sessions.length + " sessions";
          actions.appendChild(count);

          card.appendChild(actions);

          const body = document.createElement("div");
          body.className = "body";

          const sessions = document.createElement("div");
          sessions.className = "sessions";
          sessions.appendChild(renderSessionList(backend, selectedSessionID));
          body.appendChild(sessions);

          const messages = document.createElement("div");
          messages.className = "messages";
          messages.appendChild(renderMessages(backend.id, selectedSession?.id || null));
          body.appendChild(messages);

          card.appendChild(body);

          const composer = document.createElement("div");
          composer.className = "composer";

          const row = document.createElement("div");
          row.className = "composer-row";
          const agentPill = document.createElement("span");
          agentPill.className = "pill";
          agentPill.textContent = backend.defaultAgent || "implementation_lead";
          row.appendChild(agentPill);
          if (state.errorsByBackend[backend.id]) {
            const error = document.createElement("span");
            error.className = "error";
            error.textContent = state.errorsByBackend[backend.id];
            row.appendChild(error);
          }
          composer.appendChild(row);

          const textarea = document.createElement("textarea");
          textarea.placeholder = "send a message into the selected session";
          textarea.value = state.draftsByBackend[backend.id] || "";
          textarea.addEventListener("input", (event) => {
            state.draftsByBackend[backend.id] = event.target.value;
          });
          composer.appendChild(textarea);

          const sendRow = document.createElement("div");
          sendRow.className = "composer-row";
          const sendButton = document.createElement("button");
          sendButton.type = "button";
          sendButton.disabled = !!state.sendingByBackend[backend.id] || !selectedSessionID || !(state.draftsByBackend[backend.id] || "").trim();
          sendButton.textContent = state.sendingByBackend[backend.id] ? "sending..." : "send";
          sendButton.addEventListener("click", () => sendMessage(backend.id));
          sendRow.appendChild(sendButton);
          composer.appendChild(sendRow);

          card.appendChild(composer);
          grid.appendChild(card);
        }

        shell.appendChild(grid);
        root.appendChild(shell);
      }

      async function boot() {
        render();
        try {
          await refreshBackends();
        } catch (error) {
          document.getElementById("root").innerHTML = '<div class="empty" style="padding:2rem">dashboard load failed: ' + error.message + "</div>";
          return;
        }
        window.setInterval(() => {
          refreshBackends().catch((error) => {
            console.error(error);
          });
        }, POLL_MS);
      }

      boot();
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? `${bindHost}:${bindPort}`}`);

  if (requestURL.pathname === "/api/status") {
    sendJson(response, 200, { backends: await Promise.all(BACKENDS.map((backend) => probeBackend(backend))) });
    return;
  }

  if (requestURL.pathname === "/api/backends") {
    sendJson(response, 200, { backends: await collectBackendSummary() });
    return;
  }

  if (requestURL.pathname === "/api/llm-stats") {
    sendJson(response, 200, await collectLlmStatsSummary());
    return;
  }

  const createSessionMatch = requestURL.pathname.match(/^\/api\/backends\/([^/]+)\/sessions$/);
  if (createSessionMatch && request.method === "POST") {
    const backend = backendById(createSessionMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      const body = await readJsonRequest(request);
      const title = typeof body.title === "string" && body.title.trim() !== EMPTY_STRING ? body.title.trim() : `${backend.title} chat`;
      const session = await createBackendSession(backend, title);
      sendJson(response, 200, { session });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "session create failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const sessionMatch = requestURL.pathname.match(/^\/api\/backends\/([^/]+)\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    const backend = backendById(sessionMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      await deleteBackendSession(backend, sessionMatch[2]);
      sendJson(response, 200, { deleted: true });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "session delete failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const messageMatch = requestURL.pathname.match(/^\/api\/backends\/([^/]+)\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && request.method === "GET") {
    const backend = backendById(messageMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      const messages = await readBackendMessages(backend, messageMatch[2]);
      sendJson(response, 200, { messages });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "message fetch failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  if (messageMatch && request.method === "POST") {
    const backend = backendById(messageMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      const body = await readJsonRequest(request);
      const text = typeof body.text === "string" ? body.text.trim() : EMPTY_STRING;
      if (text === EMPTY_STRING) {
        sendJson(response, 400, { error: "text is required" });
        return;
      }

      const payload = await sendBackendMessage(
        backend,
        messageMatch[2],
        text,
        typeof body.agent === "string" ? body.agent : null,
      );
      sendJson(response, 200, { accepted: true, payload });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "message send failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": NO_STORE_CACHE_CONTROL,
  });
  response.end(renderDashboard());
});

server.listen(bindPort, bindHost, () => {
  process.stdout.write(`opencode-triad-dashboard listening on http://${bindHost}:${bindPort}\n`);
});
