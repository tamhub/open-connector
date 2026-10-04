import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { OracleFusionHcmCollectionKey } from "./actions.ts";

import { optionalBoolean, optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  basicAuthorizationHeader,
  parseProviderJsonBodyText,
  providerInputError,
  ProviderRequestError,
  providerResponseError,
  providerUserAgent,
  readProviderTextBody,
  requiredInputString,
  runProviderRequest,
  setSearchParams,
} from "../provider-runtime.ts";
import { oracleFusionHcmListResources } from "./actions.ts";

export const oracleFusionHcmApiVersion: string = "11.13.18.05";
export const oracleFusionHcmVersionRoot: string = `/hcmRestApi/resources/${oracleFusionHcmApiVersion}`;

const restFrameworkVersion = "4";
const maxErrorMessageCharacters = 2000;

type Phase = "validate" | "execute";
type OracleFusionHcmHandler = (input: Record<string, unknown>, context: OracleFusionHcmContext) => Promise<unknown>;

export interface OracleFusionHcmContext {
  /** Normalized origin, `https://host[:port]`. */
  baseUrl: string;
  username: string;
  password: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export const oracleFusionHcmActionHandlers: ProviderActionHandlers<"oracle_fusion_hcm", OracleFusionHcmHandler> = {
  list_workers: (input, context) => listCollection("list_workers", input, context),
  list_departments: (input, context) => listCollection("list_departments", input, context),
  list_jobs: (input, context) => listCollection("list_jobs", input, context),
  list_positions: (input, context) => listCollection("list_positions", input, context),
  list_locations: (input, context) => listCollection("list_locations", input, context),
  list_grades: (input, context) => listCollection("list_grades", input, context),
  list_absences: (input, context) => listCollection("list_absences", input, context),
  async get_worker(input, context) {
    const workerId = requiredInputString(input.workerId, "workerId");
    if (workerId.includes("/")) {
      throw providerInputError("workerId must be the opaque uniqueId from list_workers, not a path");
    }
    const payload = await requestOracle(
      context,
      `workers/${encodeURIComponent(workerId)}`,
      { fields: optionalString(input.fields), expand: optionalString(input.expand), onlyData: "true" },
      "execute",
    );
    return { worker: stripLinks(optionalRecord(payload) ?? {}) };
  },
  async query_resource(input, context) {
    const path = normalizeResourcePath(input.path);
    const onlyData = optionalBoolean(input.onlyData) ?? true;
    const payload = await requestOracle(
      context,
      path,
      { ...standardQuery(input), onlyData: String(onlyData) },
      "execute",
    );
    return { data: payload };
  },
};

export function createOracleFusionHcmContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): OracleFusionHcmContext {
  return {
    baseUrl: normalizeOracleFusionHcmBaseUrl(values.restServerUrl),
    username: requiredString(values.username, "username", providerInputError),
    password: requiredString(values.password, "password", providerInputError),
    fetcher,
    signal,
  };
}

/**
 * Accept a pod host with or without `https://`, drop any path/query, and return
 * `https://host[:port]`. Anything that is not https, carries credentials, or
 * targets a non-public address is rejected.
 */
export function normalizeOracleFusionHcmBaseUrl(value: unknown): string {
  const raw = requiredString(value, "restServerUrl", providerInputError);
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(raw);
  if (schemeMatch && schemeMatch[1]!.toLowerCase() !== "https") {
    throw providerInputError("restServerUrl must use https");
  }
  const url = assertPublicHttpUrl(schemeMatch ? raw : `https://${raw}`, {
    fieldName: "restServerUrl",
    createError: providerInputError,
  });
  if (url.username || url.password) {
    throw providerInputError("restServerUrl must not include credentials");
  }
  return `https://${url.host}`;
}

export async function validateOracleFusionHcmCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createOracleFusionHcmContext(values, fetcher, signal);
  await requestOracle(context, "workers", { limit: "1", onlyData: "true", fields: "PersonId" }, "validate");
  const host = new URL(context.baseUrl).host;
  return {
    profile: { accountId: `${host}:${context.username}`, displayName: `${context.username}@${host}` },
    grantedScopes: [],
    metadata: {
      restServerUrl: context.baseUrl,
      username: context.username,
      apiVersion: oracleFusionHcmApiVersion,
      validationEndpoint: "workers?limit=1&onlyData=true&fields=PersonId",
    },
  };
}

/**
 * Validate a caller-supplied resource path: relative to the version root, no
 * scheme/host, no query/fragment, no dot segments (also when percent-encoded).
 */
export function normalizeResourcePath(value: unknown): string {
  const raw = requiredInputString(value, "path");
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith("//") || raw.includes("\\")) {
    throw providerInputError("path must be relative to the REST version root, without a scheme or host");
  }
  if (/[?#]/u.test(raw)) {
    throw providerInputError("path must not contain a query string or fragment; use the query options");
  }
  const path = raw.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (path === "") {
    throw providerInputError("path is required");
  }
  if (path.toLowerCase().startsWith("hcmrestapi/")) {
    throw providerInputError(`path is relative to ${oracleFusionHcmVersionRoot}; drop that prefix`);
  }
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw providerInputError("path contains invalid percent-encoding");
    }
    if (segment === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw providerInputError("path must not contain empty or dot segments");
    }
  }
  return path;
}

async function listCollection(
  action: OracleFusionHcmCollectionKey,
  input: Record<string, unknown>,
  context: OracleFusionHcmContext,
): Promise<unknown> {
  const payload = optionalRecord(
    await requestOracle(context, oracleFusionHcmListResources[action], standardQuery(input), "execute"),
  );
  if (!payload || !Array.isArray(payload.items)) {
    throw providerResponseError("Oracle HCM returned an unexpected collection response");
  }
  const items = payload.items.map((row) => {
    const record = optionalRecord(row) ?? {};
    const uniqueId = readSelfUniqueId(record);
    const stripped = stripLinks(record);
    return uniqueId ? { uniqueId, ...stripped } : stripped;
  });
  const hasMore = payload.hasMore === true;
  const offset = optionalInteger(payload.offset) ?? optionalInteger(input.offset) ?? 0;
  return {
    items,
    count: optionalInteger(payload.count) ?? items.length,
    hasMore,
    limit: optionalInteger(payload.limit) ?? null,
    offset,
    nextOffset: hasMore ? offset + items.length : null,
    totalResults: optionalInteger(payload.totalResults) ?? null,
  };
}

function standardQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  const limit = optionalInteger(input.limit);
  const offset = optionalInteger(input.offset);
  const totalResults = optionalBoolean(input.totalResults);
  return {
    q: optionalString(input.q),
    limit: limit === undefined ? undefined : String(limit),
    offset: offset === undefined ? undefined : String(offset),
    fields: optionalString(input.fields),
    expand: optionalString(input.expand),
    orderBy: optionalString(input.orderBy),
    finder: optionalString(input.finder),
    totalResults: totalResults === undefined ? undefined : String(totalResults),
  };
}

/** The resource key is the last path segment of a row's `self` link. */
function readSelfUniqueId(row: Record<string, unknown>): string | undefined {
  if (!Array.isArray(row.links)) {
    return undefined;
  }
  for (const link of row.links) {
    const record = optionalRecord(link);
    const href = optionalString(record?.href);
    if (record?.rel === "self" && href) {
      const segment = href.split(/[?#]/u)[0]!.replace(/\/+$/u, "").split("/").pop();
      return segment ? decodeURIComponent(segment) : undefined;
    }
  }
  return undefined;
}

function stripLinks(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "links") continue;
    output[key] = stripLinksDeep(entry);
  }
  return output;
}

function stripLinksDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLinksDeep);
  const record = optionalRecord(value);
  return record ? stripLinks(record) : value;
}

async function requestOracle(
  context: OracleFusionHcmContext,
  path: string,
  query: Record<string, string | undefined>,
  phase: Phase,
): Promise<unknown> {
  const url = new URL(`${context.baseUrl}${oracleFusionHcmVersionRoot}/${path}`);
  setSearchParams(url, query);
  return runProviderRequest({ signal: context.signal, label: "Oracle HCM" }, async (signal) => {
    const response = await context.fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: basicAuthorizationHeader(`${context.username}:${context.password}`),
        "rest-framework-version": restFrameworkVersion,
        "user-agent": providerUserAgent,
      },
      signal,
    });
    const text = await readProviderTextBody(response, "Oracle HCM response");
    if (!response.ok) {
      const message = extractOracleErrorMessage(text) ?? `Oracle HCM request failed with HTTP ${response.status}`;
      const status = phase === "validate" && [401, 403, 404].includes(response.status) ? 400 : response.status;
      throw new ProviderRequestError(status, message);
    }
    return parseProviderJsonBodyText(text, { emptyBody: {}, invalidJsonMessage: "Oracle HCM returned invalid JSON" });
  });
}

/** Oracle reports errors as JSON (`o:errorDetails`, `detail`, `title`) or as plain text/HTML. */
export function extractOracleErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let message: string | undefined;
  try {
    const payload = optionalRecord(JSON.parse(trimmed) as unknown);
    if (payload) {
      const details = Array.isArray(payload["o:errorDetails"])
        ? payload["o:errorDetails"]
            .map((entry) => optionalString(optionalRecord(entry)?.detail))
            .filter((entry): entry is string => entry !== undefined)
        : [];
      message =
        (details.length > 0 ? details.join("; ") : undefined) ??
        optionalString(payload.detail) ??
        optionalString(payload.title) ??
        optionalString(payload.message);
    }
  } catch {
    message = trimmed.startsWith("<") ? undefined : trimmed;
  }
  return message?.slice(0, maxErrorMessageCharacters);
}
