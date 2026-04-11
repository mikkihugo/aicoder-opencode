#!/home/mhugo/.nix-profile/bin/node

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_BIND_PORT = 8090;
const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".config", "openchamber", "settings.json");
const HEALTH_PATH = "/__router/health";
const EMPTY_STRING = "";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function parseJson(value, fallbackValue) {
  if (typeof value !== "string" || value.trim() === EMPTY_STRING) {
    return fallbackValue;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallbackValue;
  }
}

function normalizeDirectory(directoryPath) {
  if (typeof directoryPath !== "string") {
    return null;
  }

  const trimmed = directoryPath.trim();
  if (trimmed === EMPTY_STRING) {
    return null;
  }

  return path.resolve(trimmed);
}

function normalizeRouteTable(routeTable) {
  const entries = Object.entries(routeTable ?? {});
  const normalizedEntries = entries
    .map(([directoryPath, origin]) => {
      const normalizedDirectory = normalizeDirectory(directoryPath);
      if (!normalizedDirectory || typeof origin !== "string" || origin.trim() === EMPTY_STRING) {
        return null;
      }

      const normalizedOrigin = origin.trim().replace(/\/+$/, EMPTY_STRING);
      return [normalizedDirectory, normalizedOrigin];
    })
    .filter(Boolean);

  return Object.fromEntries(normalizedEntries);
}

function findDirectoryRoute(routeTable, directoryPath) {
  const normalizedDirectory = normalizeDirectory(directoryPath);
  if (!normalizedDirectory) {
    return null;
  }

  const candidates = Object.entries(routeTable)
    .filter(([repoRoot]) => normalizedDirectory === repoRoot || normalizedDirectory.startsWith(`${repoRoot}${path.sep}`))
    .sort((leftEntry, rightEntry) => rightEntry[0].length - leftEntry[0].length);

  return candidates[0]?.[1] ?? null;
}

async function readActiveProjectDirectory(settingsPath) {
  const rawSettings = await fs.readFile(settingsPath, "utf8");
  const settings = JSON.parse(rawSettings);
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const activeProjectId = typeof settings.activeProjectId === "string" ? settings.activeProjectId : EMPTY_STRING;
  const activeProject = projects.find((project) => project?.id === activeProjectId) ?? projects[0] ?? null;
  return normalizeDirectory(activeProject?.path ?? null);
}

function filterRequestHeaders(headers) {
  const filteredHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        filteredHeaders.append(name, item);
      }
      continue;
    }

    filteredHeaders.set(name, String(value));
  }

  return filteredHeaders;
}

function copyResponseHeaders(sourceHeaders, response) {
  for (const [name, value] of sourceHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    response.setHeader(name, value);
  }
}

function requestHasBody(method) {
  return !["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

const ROUTE_TABLE = normalizeRouteTable(
  parseJson(process.env.OPENCHAMBER_PROJECT_ROUTES, {
    "/home/mhugo/code/aicoder-opencode": "http://127.0.0.1:8080",
    "/home/mhugo/code/dr-repo": "http://127.0.0.1:8082",
    "/home/mhugo/code/letta-workspace": "http://127.0.0.1:8084",
  }),
);
const SETTINGS_PATH = process.env.OPENCHAMBER_SETTINGS_PATH ?? DEFAULT_SETTINGS_PATH;
const BIND_HOST = process.env.OPENCHAMBER_ROUTER_HOST?.trim() || DEFAULT_BIND_HOST;
const parsedBindPort = Number.parseInt(process.env.OPENCHAMBER_ROUTER_PORT ?? EMPTY_STRING, 10);
const BIND_PORT = Number.isFinite(parsedBindPort) && parsedBindPort > 0 ? parsedBindPort : DEFAULT_BIND_PORT;

async function resolveTargetOrigin(request) {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${BIND_HOST}:${BIND_PORT}`}`);
  const headerDirectory = request.headers["x-opencode-directory"];
  const queryDirectory = requestUrl.searchParams.get("directory");
  const requestedDirectory = Array.isArray(headerDirectory) ? headerDirectory[0] : headerDirectory || queryDirectory;

  const directRoute = findDirectoryRoute(ROUTE_TABLE, requestedDirectory);
  if (directRoute) {
    return directRoute;
  }

  const activeProjectDirectory = await readActiveProjectDirectory(SETTINGS_PATH).catch(() => null);
  const activeRoute = findDirectoryRoute(ROUTE_TABLE, activeProjectDirectory);
  if (activeRoute) {
    return activeRoute;
  }

  throw new Error("No OpenCode route configured for requested or active project");
}

const server = http.createServer(async (request, response) => {
  if ((request.url ?? EMPTY_STRING) === HEALTH_PATH) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", routes: ROUTE_TABLE }));
    return;
  }

  try {
    const targetOrigin = await resolveTargetOrigin(request);
    const targetUrl = new URL(request.url ?? "/", targetOrigin);
    const upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: requestHasBody(request.method) ? Readable.toWeb(request) : undefined,
      duplex: requestHasBody(request.method) ? "half" : undefined,
      redirect: "manual",
    });

    response.statusCode = upstreamResponse.status;
    response.statusMessage = upstreamResponse.statusText;
    copyResponseHeaders(upstreamResponse.headers, response);

    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstreamResponse.body).pipe(response);
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "OpenCode route unavailable",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

server.listen(BIND_PORT, BIND_HOST, () => {
  process.stdout.write(`openchamber-opencode-router listening on http://${BIND_HOST}:${BIND_PORT}\n`);
});
