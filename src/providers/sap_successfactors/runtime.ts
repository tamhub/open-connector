import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  basicAuthorizationHeader,
  parseProviderJsonBodyText,
  providerInputError,
  ProviderRequestError,
  providerResponseError,
  providerUserAgent,
  readProviderErrorTextBody,
  readProviderTextBody,
  requiredInputString,
  runProviderRequest,
  withRetryAfterSeconds,
} from "../provider-runtime.ts";
import { extractSapError } from "../sap_s4hana_cloud_basic/odata-runtime.ts";
import { buildSignedSamlAssertion, parseSamlPrivateKey } from "./saml.ts";

const providerLabel = "SAP SuccessFactors";
const odataPath = "/odata/v2";
const defaultTop = 50;
const maxTop = 1000;

/** Domains SAP publishes SuccessFactors API servers under (data centre hosts such as api4.successfactors.com). */
const allowedApiDomains = [
  "successfactors.com",
  "successfactors.eu",
  "sapsf.com",
  "sapsf.eu",
  "sapsf.cn",
  "ondemand.com",
  "sapcloud.cn",
];

type Phase = "validate" | "execute";

export interface SuccessFactorsContext {
  /** `https://<apiServer>/odata/v2` */
  baseUrl: string;
  /** Complete `Authorization` header value (Basic or Bearer). */
  authorization: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type Handler = (input: Record<string, unknown>, context: SuccessFactorsContext) => Promise<unknown>;

/**
 * Normalize the `apiServer` credential into an https origin and require it to be
 * a SuccessFactors API server host. Accepts a bare host or an https URL; any
 * path is dropped. Ports are not supported because API servers listen on 443.
 */
export function normalizeSuccessFactorsApiServer(value: unknown): string {
  const raw = requiredString(value, "apiServer", providerInputError);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw);
  if (hasScheme && !/^https:\/\//iu.test(raw)) throw providerInputError("apiServer must use https");
  const url = assertPublicHttpUrl(hasScheme ? raw : `https://${raw}`, {
    fieldName: "apiServer",
    createError: providerInputError,
  });
  if (url.username || url.password) throw providerInputError("apiServer must not include credentials");
  if (url.port) throw providerInputError("apiServer must not include a port");
  const host = url.hostname.toLowerCase();
  if (!allowedApiDomains.some((domain) => host.endsWith(`.${domain}`))) {
    throw providerInputError(
      "apiServer must be a SuccessFactors API server host such as api4.successfactors.com (see SAP's list of API servers)",
    );
  }
  return url.origin;
}

type SuccessFactorsAuth =
  | { mode: "saml"; clientId: string; userId: string; privateKey: string }
  | { mode: "basic"; username: string; password: string };

export interface SuccessFactorsCredentials {
  origin: string;
  companyId: string;
  auth: SuccessFactorsAuth;
}

/**
 * One credential form serves both methods, so the method is chosen from what was
 * filled in: a private key selects the SAML bearer flow, otherwise username and
 * password select Basic.
 */
export function readSuccessFactorsCredentials(values: Record<string, string>): SuccessFactorsCredentials {
  const origin = normalizeSuccessFactorsApiServer(values.apiServer);
  const companyId = requiredString(values.companyId, "companyId", providerInputError);
  const privateKey = values.privateKey?.trim();
  if (privateKey) {
    return {
      origin,
      companyId,
      auth: {
        mode: "saml",
        privateKey,
        clientId: requiredString(values.clientId, "clientId (required with privateKey)", providerInputError),
        userId: requiredString(values.userId, "userId (required with privateKey)", providerInputError),
      },
    };
  }
  const username = optionalString(values.username);
  const password = values.password;
  if (username && password) return { origin, companyId, auth: { mode: "basic", username, password } };
  throw providerInputError(
    "Provide either clientId, userId and privateKey (OAuth 2.0 SAML bearer) or username and password (Basic).",
  );
}

function accountSuffix(credentials: SuccessFactorsCredentials): string {
  return credentials.auth.mode === "saml" ? credentials.auth.userId : credentials.auth.username;
}

/** SuccessFactors Basic auth expects `username@companyId`. */
function basicAuthorization(username: string, password: string, companyId: string): string {
  const login = username.toLowerCase().endsWith(`@${companyId.toLowerCase()}`) ? username : `${username}@${companyId}`;
  return basicAuthorizationHeader(`${login}:${password}`);
}

function tokenErrorMessage(text: string, fallback: string): string {
  try {
    const parsed = optionalRecord(JSON.parse(text) as unknown);
    const description = optionalString(parsed?.error_description);
    if (description) return description;
    const error = parsed?.error;
    if (typeof error === "string" && error) return error;
  } catch {
    // Not JSON.
  }
  return extractSapError(text, fallback).message;
}

/** Exchange a freshly signed SAML assertion for a bearer token. Called once per action. */
async function exchangeSamlToken(
  credentials: SuccessFactorsCredentials,
  auth: Extract<SuccessFactorsAuth, { mode: "saml" }>,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: Phase,
): Promise<string> {
  const tokenUrl = `${credentials.origin}/oauth/token`;
  const assertion = buildSignedSamlAssertion({
    clientId: auth.clientId,
    userId: auth.userId,
    tokenUrl,
    privateKey: parseSamlPrivateKey(auth.privateKey),
  });
  const form = new URLSearchParams({
    company_id: credentials.companyId,
    client_id: auth.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:saml2-bearer",
    assertion: Buffer.from(assertion.xml, "utf8").toString("base64"),
  });
  return runProviderRequest({ signal, label: `${providerLabel} token` }, async (requestSignal) => {
    const response = await fetcher(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": providerUserAgent,
      },
      body: form.toString(),
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, `${providerLabel} token error response`);
      const message = tokenErrorMessage(text, response.statusText || "token request rejected");
      throw new ProviderRequestError(
        phase === "validate" && response.status < 500 && response.status !== 429 ? 400 : response.status,
        `${providerLabel} token request failed: ${message}`,
      );
    }
    const text = await readProviderTextBody(response, `${providerLabel} token response`);
    const payload = optionalRecord(
      parseProviderJsonBodyText(text, {
        emptyBody: null,
        invalidJsonMessage: `${providerLabel} returned a malformed token`,
      }),
    );
    const accessToken = optionalString(payload?.access_token);
    if (!accessToken) {
      throw new ProviderRequestError(502, `${providerLabel} token response did not include an access_token`);
    }
    return accessToken;
  });
}

export async function resolveSuccessFactorsAuthorization(
  credentials: SuccessFactorsCredentials,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: Phase = "execute",
): Promise<string> {
  const { auth } = credentials;
  if (auth.mode === "basic") return basicAuthorization(auth.username, auth.password, credentials.companyId);
  return `Bearer ${await exchangeSamlToken(credentials, auth, fetcher, signal, phase)}`;
}

export async function createSuccessFactorsContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  phase: Phase = "execute",
): Promise<SuccessFactorsContext> {
  const credentials = readSuccessFactorsCredentials(values);
  return {
    baseUrl: `${credentials.origin}${odataPath}`,
    authorization: await resolveSuccessFactorsAuthorization(credentials, fetcher, signal, phase),
    fetcher,
    signal,
  };
}

/** Cheap probe: read one User, then build the connection profile. */
export async function validateSuccessFactorsCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const credentials = readSuccessFactorsCredentials(values);
  const context: SuccessFactorsContext = {
    baseUrl: `${credentials.origin}${odataPath}`,
    authorization: await resolveSuccessFactorsAuthorization(credentials, fetcher, signal, "validate"),
    fetcher,
    signal,
  };
  await runProviderRequest({ signal, label: providerLabel }, (requestSignal) =>
    request(context, {
      url: `${context.baseUrl}/User?$top=1&$select=userId&$format=json`,
      signal: requestSignal,
      phase: "validate",
    }),
  );
  const host = new URL(credentials.origin).host;
  return {
    profile: {
      accountId: `${host}+${credentials.companyId}+${accountSuffix(credentials)}`,
      displayName: `${providerLabel} (${credentials.companyId})`,
    },
    grantedScopes: [],
    metadata: { apiServer: credentials.origin, companyId: credentials.companyId, authMode: credentials.auth.mode },
  };
}

export const successFactorsHandlers: ProviderActionHandlers<"sap_successfactors", Handler> = {
  list_users: (input, context) => queryEntitySet(context, "User", input),
  get_user: (input, context) => getUser(context, input),
  list_employees: (input, context) =>
    queryEntitySet(context, "PerPerson", {
      ...input,
      expand: optionalString(input.expand) ?? "personalInfoNav,employmentNav",
    }),
  list_job_info: (input, context) => queryEntitySet(context, "EmpJob", input),
  list_departments: (input, context) => queryEntitySet(context, "FODepartment", input),
  list_locations: (input, context) => queryEntitySet(context, "FOLocation", input),
  list_positions: (input, context) => queryEntitySet(context, "Position", input),
  query_entity_set: (input, context) => queryEntitySet(context, requiredEntitySet(input.entitySet), input),
  fetch_next_page: (input, context) => fetchNextPage(context, input),
};

function requiredEntitySet(value: unknown): string {
  const entitySet = requiredInputString(value, "entitySet");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entitySet)) {
    throw providerInputError("entitySet must be an entity set name such as EmpJob");
  }
  return entitySet;
}

function queryString(parts: [string, string | undefined][]): string {
  return parts
    .filter((part): part is [string, string] => part[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

function readIntegerOption(value: unknown, fieldName: string, minimum: number, maximum?: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = optionalInteger(value);
  if (number === undefined || number < minimum || (maximum !== undefined && number > maximum)) {
    throw providerInputError(
      maximum === undefined
        ? `${fieldName} must be an integer of at least ${minimum}`
        : `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return number;
}

function buildCollectionQuery(input: Record<string, unknown>): string {
  const top = readIntegerOption(input.top, "top", 1, maxTop) ?? defaultTop;
  const skip = readIntegerOption(input.skip, "skip", 0);
  return queryString([
    ["$filter", optionalString(input.filter)],
    ["$select", optionalString(input.select)],
    ["$expand", optionalString(input.expand)],
    ["$orderby", optionalString(input.orderby)],
    ["$top", String(top)],
    ["$skip", skip === undefined || skip === 0 ? undefined : String(skip)],
    ["$inlinecount", input.includeCount === true ? "allpages" : undefined],
    ["$format", "json"],
  ]);
}

async function queryEntitySet(
  context: SuccessFactorsContext,
  entitySet: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const url = `${context.baseUrl}/${entitySet}?${buildCollectionQuery(input)}`;
  const payload = await runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    request(context, { url, signal, phase: "execute" }),
  );
  return shapeCollection(payload, url);
}

async function getUser(context: SuccessFactorsContext, input: Record<string, unknown>): Promise<unknown> {
  const userId = requiredInputString(input.userId, "userId");
  const key = encodeURIComponent(`'${userId.replaceAll("'", "''")}'`);
  const query = queryString([
    ["$select", optionalString(input.select)],
    ["$expand", optionalString(input.expand)],
    ["$format", "json"],
  ]);
  const url = `${context.baseUrl}/User(${key})?${query}`;
  const payload = await runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    request(context, { url, signal, phase: "execute" }),
  );
  const entity = optionalRecord(optionalRecord(payload)?.d);
  if (!entity) throw providerResponseError(`${providerLabel} user response is missing`);
  return { user: entity };
}

async function fetchNextPage(context: SuccessFactorsContext, input: Record<string, unknown>): Promise<unknown> {
  const link = requiredInputString(input.nextLink, "nextLink");
  let parsed: URL;
  try {
    parsed = new URL(link, `${context.baseUrl}/`);
  } catch {
    throw providerInputError("nextLink must be a URL or path returned by a previous query");
  }
  if (!parsed.pathname.startsWith(`${odataPath}/`)) {
    throw providerInputError(`nextLink must point into ${odataPath}/ as returned by a previous query`);
  }
  // Only the path and query are reused so the request always goes to the configured API server.
  const origin = new URL(context.baseUrl).origin;
  const url = `${origin}${parsed.pathname}${parsed.search}`;
  const payload = await runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    request(context, { url, signal, phase: "execute" }),
  );
  return shapeCollection(payload, url);
}

async function request(
  context: SuccessFactorsContext,
  options: { url: string; signal: AbortSignal; phase: Phase },
): Promise<unknown> {
  const response = await context.fetcher(options.url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: context.authorization,
      "user-agent": providerUserAgent,
    },
    signal: options.signal,
  });
  if (!response.ok) throw await createError(response, options.phase);
  const text = await readProviderTextBody(response, `${providerLabel} response`);
  return parseProviderJsonBodyText(text, {
    emptyBody: null,
    invalidJsonMessage: `${providerLabel} returned malformed JSON`,
  });
}

async function createError(response: Response, phase: Phase): Promise<ProviderRequestError> {
  const text = await readProviderErrorTextBody(response, `${providerLabel} error response`);
  const { message, code } = extractSapError(text, response.statusText || `${providerLabel} request failed`);
  let status = response.status;
  if (phase === "validate" && [400, 401, 403, 404].includes(status)) status = 400;
  const details = withRetryAfterSeconds(response, code ? { sapCode: code } : undefined);
  return new ProviderRequestError(status || 500, message, details);
}

/** Normalize an OData v2 collection (`d.results`, `d.__next`, `d.__count`). */
function shapeCollection(payload: unknown, requestUrl: string): Record<string, unknown> {
  const d = optionalRecord(optionalRecord(payload)?.d);
  if (!d || !Array.isArray(d.results)) {
    throw providerResponseError(`${providerLabel} response did not contain an entity collection`);
  }
  const next = d.__next;
  const total = typeof d.__count === "string" || typeof d.__count === "number" ? Number(d.__count) : Number.NaN;
  return compactObject({
    records: d.results,
    nextLink: typeof next === "string" && next ? toHostIndependentLink(next, requestUrl) : undefined,
    totalCount: Number.isFinite(total) ? total : undefined,
  });
}

function toHostIndependentLink(link: string, requestUrl: string): string {
  try {
    const url = new URL(link, requestUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return link;
  }
}
