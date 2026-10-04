import type { CredentialValidationResult } from "../../core/types.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  createProviderTimeout,
  parseProviderJsonBodyText,
  providerInputError,
  ProviderRequestError,
  providerResponseError,
  providerUserAgent,
  readProviderErrorTextBody,
  readProviderTextBody,
  runProviderRequest,
  withRetryAfterSeconds,
} from "../provider-runtime.ts";

/**
 * Service Layer session runtime. Every action logs in, runs its request(s) with the
 * session cookies and logs out again, so sessions never pile up against the licence count.
 */

export type B1ApiVersion = "v1" | "v2";

export interface B1Context {
  /** Https origin of the Service Layer host, for example `https://b1.example.com:50000`. */
  origin: string;
  apiVersion: B1ApiVersion;
  companyDb: string;
  username: string;
  password: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export interface B1Session {
  /** `Cookie` header value built from the login response. */
  cookie: string;
  serviceLayerVersion?: string;
}

/** Everything needed to end a session later, independent of the action context. */
export interface B1SessionHandle {
  root: string;
  cookie: string;
  fetcher: typeof fetch;
}

const providerLabel = "SAP Business One";
const logoutTimeoutMs = 10_000;

/**
 * Normalize the `serviceLayerUrl` credential into an https origin. Accepts a bare host,
 * `host:port` or an https URL; an explicit port is kept and any path (such as a pasted
 * `/b1s/v2/...`), query or fragment is dropped.
 */
export function normalizeServiceLayerUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const raw = requiredString(value, "serviceLayerUrl", providerInputError);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw);
  if (hasScheme && !/^https:\/\//iu.test(raw)) {
    throw providerInputError("serviceLayerUrl must use https");
  }
  const url = assertPublicHttpUrl(hasScheme ? raw : `https://${raw}`, {
    fieldName: "serviceLayerUrl",
    createError: providerInputError,
    allowPrivateNetwork,
  });
  if (url.username || url.password) {
    throw providerInputError("serviceLayerUrl must not include credentials");
  }
  return url.origin;
}

export function resolveApiVersion(value: unknown): B1ApiVersion {
  const raw = optionalString(value)?.toLowerCase();
  if (raw === undefined || raw === "v2" || raw === "2") return "v2";
  if (raw === "v1" || raw === "1") return "v1";
  throw providerInputError("apiVersion must be v1 or v2");
}

export function serviceRoot(context: Pick<B1Context, "origin" | "apiVersion">): string {
  return `${context.origin}/b1s/${context.apiVersion}`;
}

export function createB1Context(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): B1Context {
  const password = values.password;
  // The password is used verbatim: trimming would silently change a valid secret.
  if (!password) throw providerInputError("password is required.");
  return {
    origin: normalizeServiceLayerUrl(values.serviceLayerUrl),
    apiVersion: resolveApiVersion(values.apiVersion),
    companyDb: requiredString(values.companyDb, "companyDb", providerInputError),
    username: requiredString(values.username, "username", providerInputError),
    password,
    fetcher,
    signal,
  };
}

/** Pair up `name=value` parts of every Set-Cookie header, dropping attributes such as Path or HttpOnly. */
export function collectCookies(headers: Headers): string[] {
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return setCookies.map((cookie) => cookie.split(";")[0]!.trim()).filter((pair) => pair.includes("="));
}

export async function login(context: B1Context, signal: AbortSignal): Promise<B1Session> {
  const response = await context.fetcher(`${serviceRoot(context)}/Login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": providerUserAgent },
    body: JSON.stringify({ CompanyDB: context.companyDb, UserName: context.username, Password: context.password }),
    signal,
  });
  if (!response.ok) throw await createB1Error(response, "login");
  const text = await readProviderTextBody(response, "SAP Business One login response");
  const payload = optionalRecord(
    parseProviderJsonBodyText(text, {
      emptyBody: null,
      invalidJsonMessage: "SAP Business One returned malformed JSON",
    }),
  );
  const pairs = collectCookies(response.headers);
  const sessionId = optionalString(payload?.SessionId);
  if (!pairs.some((pair) => pair.startsWith("B1SESSION="))) {
    if (!sessionId) throw providerResponseError("SAP Business One login did not return a session");
    pairs.unshift(`B1SESSION=${sessionId}`);
  }
  return { cookie: pairs.join("; "), serviceLayerVersion: optionalString(payload?.Version) };
}

/** Best-effort logout: it must never replace the outcome of the action that used the session. */
export async function logoutQuietly(handle: B1SessionHandle): Promise<void> {
  const timeout = createProviderTimeout(undefined, logoutTimeoutMs);
  try {
    const response = await handle.fetcher(`${handle.root}/Logout`, {
      method: "POST",
      headers: { accept: "application/json", cookie: handle.cookie, "user-agent": providerUserAgent },
      signal: timeout.signal,
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // The session simply expires on the server after its idle timeout.
  } finally {
    timeout.cleanup();
  }
}

export function sessionHandle(context: B1Context, session: B1Session): B1SessionHandle {
  return { root: serviceRoot(context), cookie: session.cookie, fetcher: context.fetcher };
}

export async function withB1Session<T>(
  context: B1Context,
  signal: AbortSignal,
  run: (session: B1Session) => Promise<T>,
): Promise<T> {
  const session = await login(context, signal);
  try {
    return await run(session);
  } finally {
    await logoutQuietly(sessionHandle(context, session));
  }
}

export interface B1RequestOptions {
  method: string;
  /** Absolute URL under the configured origin. */
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
}

export interface B1Response {
  status: number;
  payload: unknown;
}

export async function b1Request(
  context: B1Context,
  session: B1Session,
  options: B1RequestOptions,
): Promise<B1Response> {
  const response = await context.fetcher(options.url, {
    method: options.method,
    headers: {
      accept: "application/json",
      cookie: session.cookie,
      "user-agent": providerUserAgent,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal,
  });
  if (!response.ok) throw await createB1Error(response, "request");
  const text = await readProviderTextBody(response, "SAP Business One response");
  const payload = parseProviderJsonBodyText(text, {
    emptyBody: null,
    invalidJsonMessage: "SAP Business One returned malformed JSON",
  });
  return { status: response.status, payload };
}

/** Log in, run one callback with the session and log out, all under a single request budget. */
export function runB1Session<T>(
  context: B1Context,
  run: (session: B1Session, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    withB1Session(context, signal, (session) => run(session, signal)),
  );
}

async function createB1Error(response: Response, phase: "login" | "request"): Promise<ProviderRequestError> {
  const text = await readProviderErrorTextBody(response, "SAP Business One error response");
  const { message, code } = extractB1Error(text, response.statusText);
  let status = response.status || 500;
  let finalMessage = message;
  if (phase === "login") {
    if ([400, 401, 403].includes(status)) {
      status = 401;
      finalMessage = `SAP Business One login failed: ${message}. Check the company database, user name and password.`;
    }
  } else if (status === 401) {
    finalMessage = `SAP Business One session was rejected or expired (${message}). Retry the action; if it keeps failing check that the user is still active and licensed.`;
  }
  const details = withRetryAfterSeconds(response, code ? { sapCode: code } : undefined);
  return new ProviderRequestError(status, finalMessage, details);
}

/** Pull the message out of a v1 (`error.message.value`) or v2 (`error.message`) Service Layer error body. */
export function extractB1Error(text: string, fallback: string): { message: string; code?: string } {
  const defaultMessage = fallback || "SAP Business One request failed";
  const trimmed = text.trim();
  if (!trimmed) return { message: defaultMessage };
  try {
    const error = optionalRecord(optionalRecord(JSON.parse(trimmed) as unknown)?.error);
    if (error) {
      const code = error.code === undefined || error.code === null ? undefined : String(error.code);
      return {
        message:
          optionalString(optionalRecord(error.message)?.value) ?? optionalString(error.message) ?? defaultMessage,
        code,
      };
    }
  } catch {
    // Not JSON: fall through to plain text handling.
  }
  return { message: trimmed.startsWith("<") ? defaultMessage : trimmed.slice(0, 500) };
}

/**
 * Login proves the credentials; the company info call only enriches the profile
 * and is allowed to fail (it needs different authorizations and differs by version).
 */
export async function validateB1Credential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createB1Context(values, fetcher, signal);
  let companyName: string | undefined;
  let serviceLayerVersion: string | undefined;
  try {
    await runB1Session(context, async (session, requestSignal) => {
      serviceLayerVersion = session.serviceLayerVersion;
      companyName = await readCompanyName(context, session, requestSignal);
    });
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 401) {
      throw new ProviderRequestError(400, error.message, error.details, error.code);
    }
    throw error;
  }
  const host = new URL(context.origin).host;
  return {
    profile: {
      accountId: `${host}/${context.companyDb}/${context.username}`,
      displayName: `SAP Business One (${companyName ?? context.companyDb}, ${context.username})`,
    },
    grantedScopes: [],
    metadata: {
      serviceLayerUrl: context.origin,
      companyDb: context.companyDb,
      apiVersion: context.apiVersion,
      ...(serviceLayerVersion ? { serviceLayerVersion } : {}),
      ...(companyName ? { companyName } : {}),
    },
  };
}

async function readCompanyName(
  context: B1Context,
  session: B1Session,
  signal: AbortSignal,
): Promise<string | undefined> {
  const url = `${serviceRoot(context)}/CompanyService_GetCompanyInfo`;
  for (const method of ["POST", "GET"]) {
    try {
      const { payload } = await b1Request(context, session, {
        method,
        url,
        signal,
        body: method === "POST" ? {} : undefined,
      });
      return optionalString(optionalRecord(payload)?.CompanyName);
    } catch (error) {
      if (signal.aborted) throw error;
      // Version differences surface as 404/405; anything else just means no company name.
      if (!(error instanceof ProviderRequestError) || ![404, 405].includes(error.status)) return undefined;
    }
  }
  return undefined;
}
