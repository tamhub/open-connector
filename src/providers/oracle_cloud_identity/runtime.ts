import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { optionalBoolean, optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
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
  setSearchParams,
} from "../provider-runtime.ts";

export const oracleCloudIdentityDefaultScope = "urn:opc:idm:__myscopes__";
const hostSuffix = ".identity.oraclecloud.com";
const adminRoot = "/admin/v1";
const scimContentType = "application/scim+json";
const patchOpSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const maxErrorMessageCharacters = 2000;
const defaultSearchCount = 25;

type Phase = "validate" | "execute";
type Handler = (input: Record<string, unknown>, context: OracleCloudIdentityContext) => Promise<unknown>;

export interface OracleCloudIdentityContext {
  /** Normalized identity domain host, no scheme. */
  host: string;
  /** `https://host` */
  baseUrl: string;
  /** `Bearer <token>` obtained for this action. */
  authorization: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

interface ClientCredentials {
  host: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/**
 * Accept an IDCS instance id (`idcs-<32 hex>`) or an identity domain URL / host
 * ending in `.identity.oraclecloud.com`, and return the bare host. Other hosts,
 * non-https schemes, credentials and ports are rejected.
 */
export function normalizeOracleCloudIdentityHost(value: unknown): string {
  const raw = requiredString(value, "serviceInstance", providerInputError);
  if (/^idcs-[a-f0-9]{32}$/iu.test(raw)) {
    return `${raw.toLowerCase()}${hostSuffix}`;
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(raw);
  if (schemeMatch && schemeMatch[1]!.toLowerCase() !== "https") {
    throw providerInputError("serviceInstance must use https");
  }
  let url: URL;
  try {
    url = new URL(schemeMatch ? raw : `https://${raw}`);
  } catch {
    throw providerInputError("serviceInstance must be an IDCS instance id such as idcs-<32 hex> or a domain URL");
  }
  if (url.username || url.password) {
    throw providerInputError("serviceInstance must not include credentials");
  }
  if (url.port) {
    throw providerInputError("serviceInstance must not include a port");
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(hostSuffix) || host.length <= hostSuffix.length || host.startsWith(".")) {
    throw providerInputError(`serviceInstance must be an idcs-<32 hex> id or a host ending in ${hostSuffix}`);
  }
  assertPublicHttpUrl(`https://${host}`, { fieldName: "serviceInstance", createError: providerInputError });
  return host;
}

function readClientCredentials(values: Record<string, string>): ClientCredentials {
  const clientSecret = values.clientSecret;
  if (!clientSecret) throw providerInputError("clientSecret is required.");
  return {
    host: normalizeOracleCloudIdentityHost(values.serviceInstance),
    clientId: requiredString(values.clientId, "clientId", providerInputError),
    clientSecret,
    scope: values.scope?.trim() || oracleCloudIdentityDefaultScope,
  };
}

/** Exchange the client credentials for a short-lived bearer token. Called once per action. */
async function exchangeToken(
  credentials: ClientCredentials,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: Phase,
): Promise<string> {
  const form = new URLSearchParams({ grant_type: "client_credentials", scope: credentials.scope });
  return runProviderRequest({ signal, label: "Oracle Cloud Identity token" }, async (requestSignal) => {
    const response = await fetcher(`https://${credentials.host}/oauth2/v1/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: basicAuthorizationHeader(`${credentials.clientId}:${credentials.clientSecret}`),
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": providerUserAgent,
      },
      body: form.toString(),
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "Oracle Cloud Identity token error response");
      const message = extractOracleCloudIdentityError(text) ?? response.statusText ?? `HTTP ${response.status}`;
      throw new ProviderRequestError(
        phase === "validate" && response.status < 500 && response.status !== 429 ? 400 : response.status,
        `Oracle Cloud Identity token request failed: ${message}`,
      );
    }
    const text = await readProviderTextBody(response, "Oracle Cloud Identity token response");
    const payload = optionalRecord(
      parseProviderJsonBodyText(text, {
        emptyBody: null,
        invalidJsonMessage: "Oracle Cloud Identity returned a malformed token",
      }),
    );
    const accessToken = optionalString(payload?.access_token);
    if (!accessToken) {
      throw new ProviderRequestError(502, "Oracle Cloud Identity token response did not include an access_token");
    }
    return accessToken;
  });
}

export async function createOracleCloudIdentityContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  phase: Phase = "execute",
): Promise<OracleCloudIdentityContext> {
  const credentials = readClientCredentials(values);
  const accessToken = await exchangeToken(credentials, fetcher, signal, phase);
  return {
    host: credentials.host,
    baseUrl: `https://${credentials.host}`,
    authorization: `Bearer ${accessToken}`,
    fetcher,
    signal,
  };
}

export const oracleCloudIdentityActionHandlers: ProviderActionHandlers<"oracle_cloud_identity", Handler> = {
  async list_users(input, context) {
    return listResources(context, "Users", listQuery(input));
  },
  async list_groups(input, context) {
    return listResources(context, "Groups", listQuery(input));
  },
  async list_apps(input, context) {
    return listResources(context, "Apps", listQuery(input));
  },
  async search_users(input, context) {
    const query = requiredInputString(input.query, "query");
    const term = quoteScimString(query);
    return listResources(context, "Users", {
      filter: `userName co ${term} or displayName co ${term} or emails.value co ${term}`,
      attributes: optionalString(input.attributes),
      count: String(optionalInteger(input.count) ?? defaultSearchCount),
      startIndex: toOptionalString(optionalInteger(input.startIndex)),
    });
  },
  async get_user(input, context) {
    const userId = requiredId(input.userId, "userId");
    const payload = await requestScim(context, "GET", `Users/${userId}`, {
      query: { attributes: optionalString(input.attributes) },
    });
    return { user: optionalRecord(payload) ?? {} };
  },
  async get_group(input, context) {
    const groupId = requiredId(input.groupId, "groupId");
    const includeMembers = optionalBoolean(input.includeMembers) ?? false;
    const payload = await requestScim(context, "GET", `Groups/${groupId}`, {
      query: includeMembers ? {} : { excludedAttributes: "members" },
    });
    return { group: optionalRecord(payload) ?? {} };
  },
  async get_user_groups(input, context) {
    const userId = requiredId(input.userId, "userId");
    const payload = optionalRecord(
      await requestScim(context, "GET", `Users/${userId}`, { query: { attributes: "groups" } }),
    );
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    return {
      userId,
      groups: groups.map((entry) => {
        const group = optionalRecord(entry) ?? {};
        return {
          id: optionalString(group.value) ?? null,
          displayName: optionalString(group.display) ?? null,
          membershipType: optionalString(group.membershipType) ?? optionalString(group.type) ?? null,
        };
      }),
    };
  },
  async create_user(input, context) {
    const givenName = requiredInputString(input.givenName, "givenName");
    const familyName = requiredInputString(input.familyName, "familyName");
    const body = {
      schemas: [userSchema],
      userName: requiredInputString(input.userName, "userName"),
      displayName: optionalString(input.displayName) ?? `${givenName} ${familyName}`,
      name: { givenName, familyName },
      emails: [{ value: requiredInputString(input.email, "email"), type: "work", primary: true }],
      active: optionalBoolean(input.active) ?? true,
    };
    const payload = await requestScim(context, "POST", "Users", { body });
    return { user: optionalRecord(payload) ?? {} };
  },
  async set_user_active(input, context) {
    const userId = requiredId(input.userId, "userId");
    const active = optionalBoolean(input.active);
    if (active === undefined) throw providerInputError("active is required and must be a boolean");
    const payload = await requestScim(context, "PATCH", `Users/${userId}`, {
      body: { schemas: [patchOpSchema], Operations: [{ op: "replace", path: "active", value: active }] },
    });
    const user = optionalRecord(payload);
    return { userId, active, user: user && Object.keys(user).length > 0 ? user : null };
  },
  async add_user_to_group(input, context) {
    const groupId = requiredId(input.groupId, "groupId");
    const userId = requiredId(input.userId, "userId");
    await requestScim(context, "PATCH", `Groups/${groupId}`, {
      body: {
        schemas: [patchOpSchema],
        Operations: [{ op: "add", path: "members", value: [{ value: userId, type: "User" }] }],
      },
    });
    return { groupId, userId };
  },
  async remove_user_from_group(input, context) {
    const groupId = requiredId(input.groupId, "groupId");
    const userId = requiredId(input.userId, "userId");
    await requestScim(context, "PATCH", `Groups/${groupId}`, {
      body: {
        schemas: [patchOpSchema],
        Operations: [{ op: "remove", path: `members[value eq ${quoteScimString(userId)}]` }],
      },
    });
    return { groupId, userId };
  },
  async delete_user(input, context) {
    const userId = requiredId(input.userId, "userId");
    await requestScim(context, "DELETE", `Users/${userId}`, {});
    return { userId };
  },
};

/** Quote a value as a SCIM filter string literal, escaping backslashes and double quotes. */
export function quoteScimString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function requiredId(value: unknown, fieldName: string): string {
  const id = requiredInputString(value, fieldName);
  if (!/^[A-Za-z0-9._-]+$/u.test(id)) {
    throw providerInputError(`${fieldName} must be a resource id returned by the list actions`);
  }
  return id;
}

function toOptionalString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function listQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  const sortBy = optionalString(input.sortBy);
  return {
    filter: optionalString(input.filter),
    attributes: optionalString(input.attributes),
    count: toOptionalString(optionalInteger(input.count)),
    startIndex: toOptionalString(optionalInteger(input.startIndex)),
    sortBy,
    sortOrder: sortBy ? optionalString(input.sortOrder) : undefined,
  };
}

async function listResources(
  context: OracleCloudIdentityContext,
  resource: "Users" | "Groups" | "Apps",
  query: Record<string, string | undefined>,
): Promise<unknown> {
  const payload = optionalRecord(await requestScim(context, "GET", resource, { query }));
  if (!payload) throw providerResponseError("Oracle Cloud Identity returned an unexpected list response");
  const resources = Array.isArray(payload.Resources) ? payload.Resources : [];
  const startIndex = optionalInteger(payload.startIndex) ?? optionalInteger(query.startIndex) ?? 1;
  const totalResults = optionalInteger(payload.totalResults) ?? null;
  const itemsPerPage = optionalInteger(payload.itemsPerPage) ?? resources.length;
  const next = startIndex + resources.length;
  return {
    resources,
    totalResults,
    startIndex,
    itemsPerPage,
    nextStartIndex: resources.length > 0 && totalResults !== null && next <= totalResults ? next : null,
  };
}

interface ScimRequest {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

async function requestScim(
  context: OracleCloudIdentityContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: ScimRequest,
  phase: Phase = "execute",
): Promise<unknown> {
  const url = new URL(`${context.baseUrl}${adminRoot}/${path}`);
  if (options.query) setSearchParams(url, options.query);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: context.authorization,
    "user-agent": providerUserAgent,
  };
  if (options.body !== undefined) headers["content-type"] = scimContentType;
  return runProviderRequest({ signal: context.signal, label: "Oracle Cloud Identity" }, async (signal) => {
    const response = await context.fetcher(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    const text = await readProviderTextBody(response, "Oracle Cloud Identity response");
    if (!response.ok) {
      const message =
        extractOracleCloudIdentityError(text) ?? `Oracle Cloud Identity request failed with HTTP ${response.status}`;
      const status = phase === "validate" && [401, 403, 404].includes(response.status) ? 400 : response.status;
      throw new ProviderRequestError(status, message);
    }
    return parseProviderJsonBodyText(text, {
      emptyBody: {},
      invalidJsonMessage: "Oracle Cloud Identity returned invalid JSON",
    });
  });
}

/** SCIM errors carry `detail`; OAuth token errors carry `error_description`. */
export function extractOracleCloudIdentityError(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let message: string | undefined;
  try {
    const payload = optionalRecord(JSON.parse(trimmed) as unknown);
    if (payload) {
      message =
        optionalString(payload.detail) ??
        optionalString(payload.error_description) ??
        optionalString(payload.message) ??
        optionalString(payload.error);
    }
  } catch {
    message = trimmed.startsWith("<") ? undefined : trimmed;
  }
  return message?.slice(0, maxErrorMessageCharacters);
}

export async function validateOracleCloudIdentityCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = await createOracleCloudIdentityContext(values, fetcher, signal, "validate");
  const clientId = values.clientId!.trim();
  try {
    await requestScim(context, "GET", "Users", { query: { count: "1", attributes: "id" } }, "validate");
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 400) {
      throw new ProviderRequestError(
        400,
        `${error.message}. The client application is probably missing an app role: assign it User Administrator (or Identity Domain Administrator) in the domain's application settings, and make sure the requested scope covers it.`,
      );
    }
    throw error;
  }
  return {
    profile: { accountId: `${context.host}+${clientId}`, displayName: `${clientId}@${context.host}` },
    grantedScopes: [],
    metadata: {
      identityDomainHost: context.host,
      tokenEndpoint: `https://${context.host}/oauth2/v1/token`,
      validationEndpoint: `${adminRoot}/Users?count=1&attributes=id`,
    },
  };
}
