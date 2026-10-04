import type { CredentialValidationResult } from "../../core/types.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
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

const providerLabel = "SAP Concur";

/** Region codes accepted as shorthand, mapped to the token and API host published on the Concur Base URIs page. */
export const concurDatacenters: Record<string, string> = {
  us: "us.api.concursolutions.com",
  us2: "us2.api.concursolutions.com",
  eu2: "eu2.api.concursolutions.com",
  emea: "emea.api.concursolutions.com",
  apj1: "apj1.api.concursolutions.com",
  usg: "usg.api.concursolutions.com",
  glz: "glz.api.concursolutions.com",
  "us-impl": "us-impl.api.concursolutions.com",
  "emea-impl": "emea-impl.api.concursolutions.com",
  cn: "cn.api.concurcdc.cn",
};

/** Every host a token response may legitimately point the proxy at, including the www- variants Concur also publishes. */
export function concurKnownHosts(): string[] {
  const hosts = Object.values(concurDatacenters);
  return [...hosts, ...hosts.map((host) => `www-${host}`)];
}

export interface ConcurContext {
  /** Origin API calls go to, for example `https://us2.api.concursolutions.com`. */
  apiBase: string;
  /** Complete `Authorization` header value. */
  authorization: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export interface ConcurConnection {
  datacenter: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ConcurToken {
  accessToken: string;
  apiBase: string;
  refreshTokenRotated: boolean;
  companyId?: string;
}

/** Accept `us2`, `us2.api.concursolutions.com` or `https://us2.api.concursolutions.com/` and return the host. */
export function normalizeConcurDatacenter(value: unknown): string {
  const raw = requiredString(value, "datacenter", providerInputError).toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(raw) && !raw.startsWith("https://")) {
    throw providerInputError("datacenter must use https when a URL is given");
  }
  const host = raw.replace(/^https:\/\//u, "").replace(/[/?#].*$/u, "");
  if (Object.hasOwn(concurDatacenters, host)) return concurDatacenters[host]!;
  if (Object.values(concurDatacenters).includes(host)) return host;
  throw providerInputError(
    `datacenter must be one of ${Object.keys(concurDatacenters).join(", ")} or the matching api host such as ${concurDatacenters.us}.`,
  );
}

export function resolveConcurConnection(values: Record<string, string>): ConcurConnection {
  const datacenter = normalizeConcurDatacenter(values.datacenter);
  const clientSecret = values.clientSecret;
  if (!clientSecret) throw providerInputError("clientSecret is required.");
  const refreshToken = values.refreshToken?.trim();
  if (!refreshToken) throw providerInputError("refreshToken is required.");
  const tokenUrl = assertPublicHttpUrl(`https://${datacenter}/oauth2/v0/token`, {
    fieldName: "token endpoint",
    createError: providerInputError,
  }).toString();
  return {
    datacenter,
    tokenUrl,
    clientId: requiredString(values.clientId, "clientId", providerInputError),
    clientSecret,
    refreshToken,
  };
}

/** Return the origin of a geolocation value only when it is https and on a Concur domain. */
export function validatedGeolocation(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".concursolutions.com") && !host.endsWith(".concurcdc.cn")) return undefined;
  return url.origin;
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
  const firstError = optionalRecord(Array.isArray(record?.errors) ? record.errors[0] : undefined);
  return (
    optionalString(record?.error_description) ??
    optionalString(record?.Message) ??
    optionalString(record?.message) ??
    optionalString(record?.detail) ??
    optionalString(firstError?.message) ??
    optionalString(record?.error) ??
    (text.trim().slice(0, 300) || fallback)
  );
}

/** Read the company identifier out of the id_token payload when the token response carries one. */
function companyFromIdToken(idToken: unknown): string | undefined {
  const token = optionalString(idToken);
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = optionalRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
    return optionalString(claims?.companyId) ?? optionalString(claims?.company_id) ?? optionalString(claims?.company);
  } catch {
    return undefined;
  }
}

/**
 * Refresh the stored company refresh token into a short-lived access token. Called once per action.
 * A rotated refresh token in the response cannot be persisted by a gateway executor, so it is only flagged.
 */
export async function refreshConcurToken(
  connection: ConcurConnection,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: Phase,
): Promise<ConcurToken> {
  return runProviderRequest({ signal, label: "SAP Concur token" }, async (requestSignal) => {
    const response = await fetcher(connection.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": providerUserAgent,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: connection.clientId,
        client_secret: connection.clientSecret,
        refresh_token: connection.refreshToken,
      }).toString(),
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP Concur token error response");
      const message = errorMessage(text, response.statusText || `HTTP ${response.status}`);
      const clientError = response.status < 500 && response.status !== 429;
      throw new ProviderRequestError(
        clientError ? (phase === "validate" ? 400 : 401) : response.status,
        clientError
          ? `SAP Concur rejected the company refresh token or app credentials (${message}). Issue a new company refresh token (company request token, then the password grant) and check the client ID and secret.`
          : `SAP Concur token request failed: ${message}`,
        withRetryAfterSeconds(response),
      );
    }
    const text = await readProviderTextBody(response, "SAP Concur token response");
    const payload = optionalRecord(
      parseProviderJsonBodyText(text, { emptyBody: null, invalidJsonMessage: "SAP Concur returned a malformed token" }),
    );
    const accessToken = optionalString(payload?.access_token);
    if (!accessToken) throw new ProviderRequestError(502, "SAP Concur token response did not include an access_token");
    const geolocation = validatedGeolocation(payload?.geolocation);
    const returnedRefresh = optionalString(payload?.refresh_token);
    return {
      accessToken,
      apiBase: geolocation ?? `https://${connection.datacenter}`,
      refreshTokenRotated: returnedRefresh !== undefined && returnedRefresh !== connection.refreshToken,
      companyId: companyFromIdToken(payload?.id_token),
    };
  });
}

function publicApiBase(value: string): string {
  return assertPublicHttpUrl(value, { fieldName: "API host", createError: providerInputError }).origin;
}

export async function createConcurContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  phase: Phase = "execute",
): Promise<ConcurContext> {
  const connection = resolveConcurConnection(values);
  const token = await refreshConcurToken(connection, fetcher, signal, phase);
  return { apiBase: publicApiBase(token.apiBase), authorization: `Bearer ${token.accessToken}`, fetcher, signal };
}

export interface ConcurRequest {
  /** Path below the API host, starting with /. */
  path: string;
  query?: Record<string, string | undefined>;
  /** Name of the API, used in the access-denied hint. */
  family: string;
}

/** Send one Concur GET request and return the parsed JSON body (null for an empty body). */
export function concurRequest(context: ConcurContext, request: ConcurRequest): Promise<unknown> {
  return runProviderRequest({ signal: context.signal, label: providerLabel }, async (signal) => {
    const url = new URL(`${context.apiBase}${request.path}`);
    if (request.query) setSearchParams(url, request.query);
    const response = await context.fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: context.authorization,
        "user-agent": providerUserAgent,
      },
      signal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP Concur error response");
      const message = errorMessage(text, response.statusText || `HTTP ${response.status}`);
      const hint =
        response.status === 401 || response.status === 403
          ? ` Make sure the Concur app is granted the scopes the ${request.family} needs and that the refresh token is a company-level token.`
          : "";
      throw new ProviderRequestError(
        response.status,
        `SAP Concur ${request.family} request failed (HTTP ${response.status}): ${message}${hint}`,
        withRetryAfterSeconds(response),
      );
    }
    const text = await readProviderTextBody(response, "SAP Concur response");
    return parseProviderJsonBodyText(text, {
      emptyBody: null,
      invalidJsonMessage: "SAP Concur returned a response that is not valid JSON",
    });
  });
}

/** Pull the `offset` parameter out of a v3 `NextPage` URL. */
export function nextOffset(nextPage: unknown): string | undefined {
  const raw = optionalString(nextPage);
  if (!raw) return undefined;
  try {
    return new URL(raw, "https://placeholder.invalid").searchParams.get("offset") ?? undefined;
  } catch {
    return undefined;
  }
}

export async function validateConcurCredentials(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const connection = resolveConcurConnection(values);
  const token = await refreshConcurToken(connection, fetcher, signal, "validate");
  const apiBase = publicApiBase(token.apiBase);
  try {
    await concurRequest(
      { apiBase, authorization: `Bearer ${token.accessToken}`, fetcher, signal },
      { path: "/profile/identity/v4/Users", query: { count: "1" }, family: "Identity API" },
    );
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status < 500 && error.status !== 429) {
      throw new ProviderRequestError(400, error.message);
    }
    throw error;
  }
  return {
    profile: {
      accountId: [connection.datacenter, token.companyId ?? connection.clientId].join("+"),
      displayName: `${providerLabel} (${connection.datacenter})`,
    },
    grantedScopes: [],
    metadata: {
      tokenEndpoint: connection.tokenUrl,
      apiHost: apiBase,
      refreshTokenRotated: token.refreshTokenRotated,
    },
  };
}
