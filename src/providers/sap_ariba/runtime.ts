import type { CredentialValidationResult } from "../../core/types.ts";

import { optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  basicAuthorizationHeader,
  parseProviderJsonBodyText,
  providerInputError,
  ProviderRequestError,
  providerUserAgent,
  readProviderErrorTextBody,
  readProviderTextBody,
  runProviderRequest,
  setSearchParams,
  withRetryAfterSeconds,
} from "../provider-runtime.ts";

type Phase = "validate" | "execute";

const providerLabel = "SAP Ariba";

/**
 * Data centers whose OAuth host and Open APIs host follow the `{subdomain}.ariba.com` /
 * `open{subdomain}.ariba.com` pattern. The China data center lives under ariba.cn and is not supported.
 */
export const aribaDataCenters: Record<string, string> = {
  api: "US",
  "api-eu": "Europe",
  "api.au.cloud": "Australia",
  "api.jp.cloud": "Japan",
  "api.mn1": "United Arab Emirates",
  "api.mn2": "Saudi Arabia",
};

export interface AribaContext {
  subdomain: string;
  /** Origin of the Open APIs host, for example `https://openapi.ariba.com`. */
  apiBase: string;
  /** Complete `Authorization` header value. */
  authorization: string;
  apiKey: string;
  realm?: string;
  anid?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

interface AribaConnection {
  subdomain: string;
  tokenUrl: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  realm?: string;
  anid?: string;
}

/** Accept `api-eu`, `api-eu.ariba.com` or `https://api-eu.ariba.com/` and return the bare data-center prefix. */
export function normalizeAribaSubdomain(value: unknown): string {
  const raw = requiredString(value, "subdomain", providerInputError).toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(raw) && !raw.startsWith("https://")) {
    throw providerInputError("subdomain must use https when a URL is given");
  }
  const host = raw
    .replace(/^https:\/\//u, "")
    .replace(/[/?#].*$/u, "")
    .replace(/^open(?=api)/u, "")
    .replace(/\.ariba\.com$/u, "");
  if (!Object.hasOwn(aribaDataCenters, host)) {
    throw providerInputError(
      `subdomain must be one of ${Object.keys(aribaDataCenters).join(", ")} (the data center prefix of your SAP Ariba API host).`,
    );
  }
  return host;
}

function optionalRealm(value: unknown): string | undefined {
  const realm = optionalString(value);
  if (realm === undefined) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/u.test(realm)) {
    throw providerInputError("realm may only contain letters, digits, dots, hyphens and underscores");
  }
  return realm;
}

function optionalAnid(value: unknown): string | undefined {
  const anid = optionalString(value)?.toUpperCase();
  if (anid === undefined) return undefined;
  if (!/^AN[0-9]+$/u.test(anid)) throw providerInputError("anid must look like AN01234567890");
  return anid;
}

export function resolveAribaConnection(values: Record<string, string>): AribaConnection {
  const subdomain = normalizeAribaSubdomain(values.subdomain);
  const clientSecret = values.clientSecret;
  if (!clientSecret) throw providerInputError("clientSecret is required.");
  const apiKey = values.apiKey?.trim();
  if (!apiKey) throw providerInputError("apiKey is required.");
  const tokenUrl = assertPublicHttpUrl(`https://${subdomain}.ariba.com/v2/oauth/token`, {
    fieldName: "token endpoint",
    createError: providerInputError,
  }).toString();
  const apiBase = assertPublicHttpUrl(`https://open${subdomain}.ariba.com`, {
    fieldName: "API host",
    createError: providerInputError,
  }).origin;
  return {
    subdomain,
    tokenUrl,
    apiBase,
    clientId: requiredString(values.clientId, "clientId", providerInputError),
    clientSecret,
    apiKey,
    realm: optionalRealm(values.realm),
    anid: optionalAnid(values.anid),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(text: string, fallback: string): string {
  const record = optionalRecord(safeJson(text));
  const nested = optionalRecord(record?.error);
  return (
    optionalString(record?.error_description) ??
    optionalString(nested?.message) ??
    optionalString(record?.message) ??
    optionalString(record?.error) ??
    (text.trim().slice(0, 300) || fallback)
  );
}

/** Exchange the OAuth client for a short-lived bearer token. Called once per action. */
async function exchangeToken(
  connection: AribaConnection,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: Phase,
): Promise<string> {
  return runProviderRequest({ signal, label: "SAP Ariba token" }, async (requestSignal) => {
    const response = await fetcher(connection.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: basicAuthorizationHeader(`${connection.clientId}:${connection.clientSecret}`),
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": providerUserAgent,
      },
      body: new URLSearchParams({ grant_type: "openapi_2lo" }).toString(),
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP Ariba token error response");
      const message = errorMessage(text, response.statusText || `HTTP ${response.status}`);
      throw new ProviderRequestError(
        phase === "validate" && response.status < 500 && response.status !== 429 ? 400 : response.status,
        `SAP Ariba token request failed: ${message}`,
        withRetryAfterSeconds(response),
      );
    }
    const text = await readProviderTextBody(response, "SAP Ariba token response");
    const payload = optionalRecord(
      parseProviderJsonBodyText(text, { emptyBody: null, invalidJsonMessage: "SAP Ariba returned a malformed token" }),
    );
    const accessToken = optionalString(payload?.access_token);
    if (!accessToken) throw new ProviderRequestError(502, "SAP Ariba token response did not include an access_token");
    return accessToken;
  });
}

export async function createAribaContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  phase: Phase = "execute",
): Promise<AribaContext> {
  const connection = resolveAribaConnection(values);
  const accessToken = await exchangeToken(connection, fetcher, signal, phase);
  return {
    subdomain: connection.subdomain,
    apiBase: connection.apiBase,
    authorization: `Bearer ${accessToken}`,
    apiKey: connection.apiKey,
    realm: connection.realm,
    anid: connection.anid,
    fetcher,
    signal,
  };
}

/** Headers every Ariba Open API call carries besides the bearer token. */
export function aribaApiHeaders(context: Pick<AribaContext, "apiKey" | "anid">): Record<string, string> {
  const headers: Record<string, string> = { apikey: context.apiKey };
  if (context.anid) headers["x-ariba-network-id"] = context.anid;
  return headers;
}

export function resolveRealm(context: AribaContext, input: Record<string, unknown>): string {
  const realm = optionalRealm(input.realm) ?? context.realm;
  if (!realm) {
    throw providerInputError("realm is required: set it on the connection or pass it as an input.");
  }
  return realm;
}

export interface AribaRequest {
  method: "GET" | "POST" | "PATCH";
  /** Path below the Open APIs host, starting with /api/. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Name of the API product, used in the access-denied hint. */
  family: string;
}

/** Send one Open API request and return the parsed JSON body (null for an empty body). */
export function aribaRequest(context: AribaContext, request: AribaRequest): Promise<unknown> {
  return runProviderRequest({ signal: context.signal, label: providerLabel }, async (signal) => {
    const url = new URL(`${context.apiBase}${request.path}`);
    if (request.query) setSearchParams(url, request.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: context.authorization,
      "user-agent": providerUserAgent,
      ...aribaApiHeaders(context),
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    const response = await context.fetcher(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP Ariba error response");
      const message = errorMessage(text, response.statusText || `HTTP ${response.status}`);
      const hint =
        response.status === 401 || response.status === 403
          ? ` Make sure the connected application is approved for the ${request.family} in the SAP Ariba Developer Portal and that the apiKey belongs to that application.`
          : "";
      throw new ProviderRequestError(
        response.status,
        `SAP Ariba ${request.family} request failed (HTTP ${response.status}): ${message}${hint}`,
        withRetryAfterSeconds(response),
      );
    }
    const text = await readProviderTextBody(response, "SAP Ariba response");
    return parseProviderJsonBodyText(text, {
      emptyBody: null,
      invalidJsonMessage: "SAP Ariba returned a response that is not valid JSON",
    });
  });
}

const recordArrayKeys = ["Records", "records", "payload", "value", "items", "data"];

/** Normalize the several list envelopes the Ariba APIs use into records plus an optional continuation token. */
export function shapeAribaPage(payload: unknown): {
  records: Record<string, unknown>[];
  pageToken?: string;
  totalCount?: number;
} {
  const root = optionalRecord(payload);
  let list: unknown[] = [];
  if (Array.isArray(payload)) {
    list = payload;
  } else if (root) {
    for (const key of recordArrayKeys) {
      if (Array.isArray(root[key])) {
        list = root[key] as unknown[];
        break;
      }
    }
  }
  const records = list.flatMap((item) => {
    const record = optionalRecord(item);
    return record ? [record] : [];
  });
  const tokenValue = root?.PageToken ?? root?.pageToken ?? root?.nextPageToken;
  const pageToken = typeof tokenValue === "number" ? String(tokenValue) : optionalString(tokenValue);
  const meta = optionalRecord(root?.pageMetaData);
  const totalCount =
    optionalInteger(root?.count) ??
    optionalInteger(root?.Count) ??
    optionalInteger(root?.["@odata.count"]) ??
    optionalInteger(meta?.totalElements);
  return {
    records,
    ...(pageToken ? { pageToken } : {}),
    ...(totalCount === undefined ? {} : { totalCount }),
  };
}

export async function validateAribaCredentials(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const connection = resolveAribaConnection(values);
  await exchangeToken(connection, fetcher, signal, "validate");
  const scope = connection.realm ?? connection.anid;
  return {
    profile: {
      accountId: [connection.subdomain, scope, connection.clientId].filter(Boolean).join("+"),
      displayName: `${providerLabel} (${scope ?? connection.subdomain})`,
    },
    grantedScopes: [],
    metadata: {
      dataCenter: aribaDataCenters[connection.subdomain],
      tokenEndpoint: connection.tokenUrl,
      apiHost: connection.apiBase,
    },
  };
}
