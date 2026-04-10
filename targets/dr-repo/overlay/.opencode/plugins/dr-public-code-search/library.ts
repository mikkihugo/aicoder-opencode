export const GREP_APP_BASE_URL = "https://grep.app";
export const GREP_APP_SEARCH_PATH = "/search";
export const GREP_APP_API_PATH = "/api/search";
export const GREP_APP_BLOCKED_STATUS = 429;
export const DEFAULT_PUBLIC_CODE_SEARCH_LIMIT = 5;
export const MAX_PUBLIC_CODE_SEARCH_LIMIT = 10;
export const DEFAULT_PUBLIC_CODE_SEARCH_TIMEOUT_MILLISECONDS = 15_000;
export const GREP_APP_USER_AGENT = "dr-repo-opencode/1.0 (+https://grep.app)";

type RawRecord = Record<string, unknown>;

export type PublicCodeSearchFilters = {
  language?: string;
  pathPattern?: string;
  repositoryPattern?: string;
  page?: number;
};

export type PublicCodeSearchHit = {
  repository: string;
  path: string;
  language: string | null;
  snippet: string | null;
  repositoryURL: string;
};

function appendOptionalParameter(searchParams: URLSearchParams, key: string, value: string | undefined) {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return;
  }
  searchParams.set(key, normalizedValue);
}

function asRecord(value: unknown): RawRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as RawRecord;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function rawField(record: RawRecord | null, field: string): unknown {
  if (!record) {
    return undefined;
  }
  const nestedRecord = asRecord(record[field]);
  if (nestedRecord && "raw" in nestedRecord) {
    return nestedRecord.raw;
  }
  return record[field];
}

function snippetField(record: RawRecord | null): string | null {
  if (!record) {
    return null;
  }
  const content = asRecord(record.content);
  const snippet = rawField(content, "snippet");
  return asString(snippet);
}

export function normalizePublicCodeSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_PUBLIC_CODE_SEARCH_LIMIT;
  }
  const roundedLimit = Math.floor(limit as number);
  if (roundedLimit < 1) {
    return 1;
  }
  return Math.min(roundedLimit, MAX_PUBLIC_CODE_SEARCH_LIMIT);
}

export function buildGrepAppSearchURL(query: string, filters: PublicCodeSearchFilters = {}) {
  const url = new URL(GREP_APP_SEARCH_PATH, GREP_APP_BASE_URL);
  url.searchParams.set("q", query.trim());
  appendOptionalParameter(url.searchParams, "f.lang", filters.language);
  appendOptionalParameter(url.searchParams, "f.path", filters.pathPattern);
  appendOptionalParameter(url.searchParams, "f.repo", filters.repositoryPattern);
  if (typeof filters.page === "number" && Number.isFinite(filters.page) && filters.page > 1) {
    url.searchParams.set("page", String(Math.floor(filters.page)));
  }
  return url.toString();
}

export function buildGrepAppAPIURL(query: string, filters: PublicCodeSearchFilters = {}) {
  const url = new URL(GREP_APP_API_PATH, GREP_APP_BASE_URL);
  url.searchParams.set("q", query.trim());
  appendOptionalParameter(url.searchParams, "f.lang", filters.language);
  appendOptionalParameter(url.searchParams, "f.path", filters.pathPattern);
  appendOptionalParameter(url.searchParams, "f.repo", filters.repositoryPattern);
  if (typeof filters.page === "number" && Number.isFinite(filters.page) && filters.page > 1) {
    url.searchParams.set("page", String(Math.floor(filters.page)));
  }
  return url.toString();
}

export function extractPublicCodeSearchHits(payload: unknown, limit: number): PublicCodeSearchHit[] {
  const root = asRecord(payload);
  const hitsRoot = asRecord(root?.hits);
  const rawHits = Array.isArray(hitsRoot?.hits) ? hitsRoot.hits : [];
  const normalizedLimit = normalizePublicCodeSearchLimit(limit);

  return rawHits
    .map((rawHit) => {
      const hit = asRecord(rawHit);
      const repository = asString(rawField(hit, "repo"));
      const path = asString(rawField(hit, "path"));
      if (!repository || !path) {
        return null;
      }

      const language = asString(rawField(hit, "language"));
      return {
        repository,
        path,
        language,
        snippet: snippetField(hit),
        repositoryURL: new URL(repository, "https://github.com/").toString(),
      } satisfies PublicCodeSearchHit;
    })
    .filter((hit): hit is PublicCodeSearchHit => hit !== null)
    .slice(0, normalizedLimit);
}
