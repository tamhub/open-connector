import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
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

/**
 * Shared OData runtime for the SAP S/4HANA Cloud providers. The Basic Auth and
 * Client Credentials providers differ only in how `authorization` is produced.
 */

export type SapODataVersion = "v2" | "v4";
type SapRequestPhase = "validate" | "execute";

export interface SapODataContext {
  /** Origin of the API host, for example `https://my123456-api.s4hana.cloud.sap`. */
  baseUrl: string;
  /** Complete `Authorization` header value (Basic or Bearer). */
  authorization: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type SapHandler = (input: Record<string, unknown>, context: SapODataContext) => Promise<unknown>;

const providerLabel = "SAP S/4HANA Cloud";
const defaultTop = 50;
const maxTop = 1000;
const validationServicePath = "/sap/opu/odata/sap/API_BUSINESS_PARTNER";
const validationEntitySet = "A_BusinessPartner";

/** Released API services used by the convenience list actions (all OData v2). */
export const sapConvenienceServices: Record<
  "list_business_partners" | "list_sales_orders" | "list_purchase_orders" | "list_products",
  { servicePath: string; entitySet: string }
> = {
  list_business_partners: { servicePath: validationServicePath, entitySet: validationEntitySet },
  list_sales_orders: { servicePath: "/sap/opu/odata/sap/API_SALES_ORDER_SRV", entitySet: "A_SalesOrder" },
  list_purchase_orders: {
    servicePath: "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV",
    entitySet: "A_PurchaseOrder",
  },
  list_products: { servicePath: "/sap/opu/odata/sap/API_PRODUCT_SRV", entitySet: "A_Product" },
};

/**
 * Normalize the `apiServer` credential into an https origin. Accepts a bare host,
 * `host:port`, or a full https URL; any path, query or fragment is dropped.
 */
export function normalizeSapApiServer(value: unknown): string {
  const raw = requiredString(value, "apiServer", providerInputError);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw);
  if (hasScheme && !/^https:\/\//iu.test(raw)) {
    throw providerInputError("apiServer must use https");
  }
  const url = assertPublicHttpUrl(hasScheme ? raw : `https://${raw}`, {
    fieldName: "apiServer",
    createError: providerInputError,
  });
  if (url.username || url.password) {
    throw providerInputError("apiServer must not include credentials");
  }
  return url.origin;
}

export const sapODataHandlers: ProviderActionHandlers<"sap_s4hana_cloud_basic", SapHandler> = {
  query_entity_set: (input, context) =>
    queryEntitySet(
      context,
      requiredServicePath(input.servicePath),
      requiredEntitySet(input.entitySet),
      resolveVersion(input.odataVersion),
      input,
    ),
  get_entity: (input, context) => getEntity(context, input),
  fetch_next_page: (input, context) => fetchNextPage(context, input),
  list_business_partners: (input, context) => queryConvenience(context, "list_business_partners", input),
  list_sales_orders: (input, context) => queryConvenience(context, "list_sales_orders", input),
  list_purchase_orders: (input, context) => queryConvenience(context, "list_purchase_orders", input),
  list_products: (input, context) => queryConvenience(context, "list_products", input),
  create_entity: (input, context) => createEntity(context, input),
  update_entity: (input, context) => updateEntity(context, input),
};

/**
 * Cheap connectivity probe shared by both credential validators: reads one
 * Business Partner and builds the connection profile.
 */
export async function validateSapODataConnection(
  context: SapODataContext,
  accountSuffix: string,
): Promise<CredentialValidationResult> {
  await runProviderRequest({ signal: context.signal, label: providerLabel }, async (signal) => {
    const url = `${context.baseUrl}${validationServicePath}/${validationEntitySet}?$top=1&$select=BusinessPartner&$format=json`;
    await sapRequest(context, { method: "GET", url, signal, phase: "validate" });
  });
  const host = new URL(context.baseUrl).host;
  return {
    profile: {
      accountId: accountSuffix ? `${host}+${accountSuffix}` : host,
      displayName: `${providerLabel} (${host})`,
    },
    grantedScopes: [],
    metadata: { apiServer: context.baseUrl, validationEndpoint: `${validationServicePath}/${validationEntitySet}` },
  };
}

function resolveVersion(value: unknown): SapODataVersion {
  if (value === undefined || value === null) return "v2";
  if (value === "v2" || value === "v4") return value;
  throw providerInputError("odataVersion must be v2 or v4");
}

/** Accept `/sap/opu/odata/sap/X`, with or without a leading or trailing slash. */
function requiredServicePath(value: unknown): string {
  const raw = requiredInputString(value, "servicePath");
  const path = `/${raw.replace(/^\/+/u, "").replace(/\/+$/u, "")}`;
  if (path === "/" || !/^\/[A-Za-z0-9._~\-/;=()]+$/u.test(path) || path.split("/").some((part) => part === "..")) {
    throw providerInputError("servicePath must be a plain URL path such as /sap/opu/odata/sap/API_BUSINESS_PARTNER");
  }
  return path;
}

function requiredEntitySet(value: unknown): string {
  const entitySet = requiredInputString(value, "entitySet");
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(entitySet)) {
    throw providerInputError("entitySet must be an entity set name such as A_BusinessPartner");
  }
  return entitySet;
}

/** Percent-encode a raw OData key predicate while keeping its structural characters readable. */
function encodeKeyPredicate(value: unknown): string {
  let key = requiredInputString(value, "key");
  if (key.startsWith("(") && key.endsWith(")")) key = key.slice(1, -1);
  return encodeURIComponent(key).replaceAll("%3D", "=").replaceAll("%2C", ",").replaceAll("%3A", ":");
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

function buildCollectionQuery(input: Record<string, unknown>, version: SapODataVersion): string {
  const top = readIntegerOption(input.top, "top", 1, maxTop) ?? defaultTop;
  const skip = readIntegerOption(input.skip, "skip", 0);
  const parts: [string, string | undefined][] = [
    ["$filter", optionalString(input.filter)],
    ["$select", optionalString(input.select)],
    ["$expand", optionalString(input.expand)],
    ["$orderby", optionalString(input.orderby)],
    ["$top", String(top)],
    ["$skip", skip === undefined || skip === 0 ? undefined : String(skip)],
  ];
  if (input.includeCount === true) {
    parts.push(version === "v2" ? ["$inlinecount", "allpages"] : ["$count", "true"]);
  }
  if (version === "v2") parts.push(["$format", "json"]);
  return queryString(parts);
}

async function queryEntitySet(
  context: SapODataContext,
  servicePath: string,
  entitySet: string,
  version: SapODataVersion,
  input: Record<string, unknown>,
): Promise<unknown> {
  const url = `${context.baseUrl}${servicePath}/${entitySet}?${buildCollectionQuery(input, version)}`;
  const { payload } = await runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    sapRequest(context, { method: "GET", url, signal, phase: "execute" }),
  );
  return shapeCollection(payload, url);
}

function queryConvenience(
  context: SapODataContext,
  name: keyof typeof sapConvenienceServices,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { servicePath, entitySet } = sapConvenienceServices[name];
  return queryEntitySet(context, servicePath, entitySet, "v2", input);
}

async function getEntity(context: SapODataContext, input: Record<string, unknown>): Promise<unknown> {
  const version = resolveVersion(input.odataVersion);
  const servicePath = requiredServicePath(input.servicePath);
  const entitySet = requiredEntitySet(input.entitySet);
  const query = queryString([
    ["$select", optionalString(input.select)],
    ["$expand", optionalString(input.expand)],
    ["$format", version === "v2" ? "json" : undefined],
  ]);
  const url = `${context.baseUrl}${servicePath}/${entitySet}(${encodeKeyPredicate(input.key)})${query ? `?${query}` : ""}`;
  const { payload } = await runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    sapRequest(context, { method: "GET", url, signal, phase: "execute" }),
  );
  return { entity: unwrapEntity(payload) };
}

async function fetchNextPage(context: SapODataContext, input: Record<string, unknown>): Promise<unknown> {
  const link = requiredInputString(input.nextLink, "nextLink");
  let parsed: URL;
  try {
    parsed = new URL(link, `${context.baseUrl}/`);
  } catch {
    throw providerInputError("nextLink must be a URL or path returned by a previous query");
  }
  // Server paging links often carry an internal host name; only the path and query are reused.
  const url = `${context.baseUrl}${parsed.pathname}${parsed.search}`;
  const { payload } = await runProviderRequest({ signal: context.signal, label: providerLabel }, (signal) =>
    sapRequest(context, { method: "GET", url, signal, phase: "execute" }),
  );
  return shapeCollection(payload, url);
}

async function createEntity(context: SapODataContext, input: Record<string, unknown>): Promise<unknown> {
  const version = resolveVersion(input.odataVersion);
  const servicePath = requiredServicePath(input.servicePath);
  const entitySet = requiredEntitySet(input.entitySet);
  const body = requiredBody(input.body);
  const url = `${context.baseUrl}${servicePath}/${entitySet}`;
  const result = await sapWrite(context, servicePath, {
    method: "POST",
    url,
    body,
    headers: version === "v4" ? { prefer: "return=representation" } : {},
  });
  return compactObject({
    status: result.status,
    entity: result.payload === null ? undefined : unwrapEntity(result.payload),
  });
}

async function updateEntity(context: SapODataContext, input: Record<string, unknown>): Promise<unknown> {
  const version = resolveVersion(input.odataVersion);
  const servicePath = requiredServicePath(input.servicePath);
  const entitySet = requiredEntitySet(input.entitySet);
  const method = input.method === undefined ? "PATCH" : String(input.method);
  if (method !== "PATCH" && method !== "MERGE" && method !== "PUT") {
    throw providerInputError("method must be PATCH, MERGE or PUT");
  }
  const url = `${context.baseUrl}${servicePath}/${entitySet}(${encodeKeyPredicate(input.key)})`;
  const result = await sapWrite(context, servicePath, {
    method,
    url,
    body: requiredBody(input.body),
    headers: {
      "if-match": optionalString(input.etag) ?? "*",
      ...(version === "v4" ? { prefer: "return=minimal" } : {}),
    },
  });
  return compactObject({
    updated: true,
    status: result.status,
    entity: result.payload === null ? undefined : unwrapEntity(result.payload),
  });
}

function requiredBody(value: unknown): Record<string, unknown> {
  const body = optionalRecord(value);
  if (!body || Object.keys(body).length === 0) {
    throw providerInputError("body must be a non-empty object of entity properties");
  }
  return body;
}

interface SapWriteRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Fetch a CSRF token (and session cookies) from the service root, then send the write with both. */
async function sapWrite(
  context: SapODataContext,
  servicePath: string,
  request: SapWriteRequest,
): Promise<{ status: number; payload: unknown }> {
  return runProviderRequest({ signal: context.signal, label: providerLabel }, async (signal) => {
    const handshake = await sapRequest(context, {
      method: "GET",
      url: `${context.baseUrl}${servicePath}/`,
      headers: { "x-csrf-token": "fetch" },
      ignoreBody: true,
      signal,
      phase: "execute",
    });
    const headers: Record<string, string> = { ...request.headers, "content-type": "application/json" };
    if (handshake.csrfToken) headers["x-csrf-token"] = handshake.csrfToken;
    if (handshake.cookie) headers.cookie = handshake.cookie;
    const result = await sapRequest(context, {
      method: request.method,
      url: request.url,
      headers,
      body: JSON.stringify(request.body),
      signal,
      phase: "execute",
    });
    return { status: result.status, payload: result.payload };
  });
}

interface SapRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Skip JSON parsing of a successful body (the CSRF handshake reads headers only). */
  ignoreBody?: boolean;
  signal: AbortSignal;
  phase: SapRequestPhase;
}

interface SapResponse {
  status: number;
  payload: unknown;
  csrfToken?: string;
  cookie?: string;
}

async function sapRequest(context: SapODataContext, options: SapRequestOptions): Promise<SapResponse> {
  const response = await context.fetcher(options.url, {
    method: options.method,
    headers: {
      accept: "application/json",
      authorization: context.authorization,
      "user-agent": providerUserAgent,
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await createSapError(response, options.phase);
  }
  const text = await readProviderTextBody(response, "SAP S/4HANA Cloud response");
  // The CSRF handshake returns the service document, which may be XML; only data requests need JSON.
  const payload = options.ignoreBody
    ? null
    : parseProviderJsonBodyText(text, {
        emptyBody: null,
        invalidJsonMessage: "SAP S/4HANA Cloud returned malformed JSON",
      });
  return {
    status: response.status,
    payload,
    csrfToken: optionalString(response.headers.get("x-csrf-token")),
    cookie: collectCookies(response.headers),
  };
}

function collectCookies(headers: Headers): string | undefined {
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const pairs = setCookies.map((cookie) => cookie.split(";")[0]!.trim()).filter((pair) => pair.includes("="));
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

async function createSapError(response: Response, phase: SapRequestPhase): Promise<ProviderRequestError> {
  const text = await readProviderErrorTextBody(response, "SAP S/4HANA Cloud error response");
  const { message, code } = extractSapError(text, response.statusText);
  let status = response.status;
  let finalMessage = message;
  if (phase === "validate" && [400, 401, 403, 404].includes(status)) {
    if (status === 403 || status === 404) {
      finalMessage = `${message} (check that the communication arrangement exposes the Business Partner API to this user)`;
    }
    status = 400;
  }
  const details = withRetryAfterSeconds(response, code ? { sapCode: code } : undefined);
  return new ProviderRequestError(status || 500, finalMessage, details);
}

/** Pull the message out of an OData v2 (`error.message.value`), v4 (`error.message`) or XML error body. */
export function extractSapError(text: string, fallback: string): { message: string; code?: string } {
  const defaultMessage = fallback || "SAP S/4HANA Cloud request failed";
  const trimmed = text.trim();
  if (!trimmed) return { message: defaultMessage };
  try {
    const error = optionalRecord(optionalRecord(JSON.parse(trimmed) as unknown)?.error);
    if (error) {
      const message = optionalRecord(error.message);
      const innerDetails = Array.isArray(optionalRecord(error.innererror)?.errordetails)
        ? optionalRecord((optionalRecord(error.innererror)!.errordetails as unknown[])[0])
        : undefined;
      const firstDetail = Array.isArray(error.details)
        ? optionalString(optionalRecord(error.details[0])?.message)
        : undefined;
      return {
        message:
          optionalString(message?.value) ??
          optionalString(error.message) ??
          optionalString(innerDetails?.message) ??
          firstDetail ??
          defaultMessage,
        code: optionalString(error.code),
      };
    }
  } catch {
    // Not JSON: fall through to XML and plain text handling.
  }
  const xml = /<message[^>]*>([^<]+)<\/message>/iu.exec(trimmed);
  if (xml?.[1]) return { message: xml[1].trim() };
  return { message: trimmed.startsWith("<") ? defaultMessage : trimmed.slice(0, 500) };
}

function unwrapEntity(payload: unknown): Record<string, unknown> {
  const root = optionalRecord(payload);
  if (!root) throw providerResponseError("SAP S/4HANA Cloud entity response is missing");
  const wrapped = optionalRecord(root.d);
  if (wrapped) return wrapped;
  const { "@odata.context": _context, ...entity } = root;
  return entity;
}

/** Normalize a v2 (`d.results`, `d.__next`) or v4 (`value`, `@odata.nextLink`) collection response. */
function shapeCollection(payload: unknown, requestUrl: string): Record<string, unknown> {
  const root = optionalRecord(payload);
  if (!root) throw providerResponseError("SAP S/4HANA Cloud collection response is missing");
  const wrapped = root.d;
  const v2 = optionalRecord(wrapped);
  let records: unknown;
  let next: unknown;
  let count: unknown;
  if (v2 && Array.isArray(v2.results)) {
    records = v2.results;
    next = v2.__next;
    count = v2.__count;
  } else if (Array.isArray(wrapped)) {
    records = wrapped;
  } else if (Array.isArray(root.value)) {
    records = root.value;
    next = root["@odata.nextLink"];
    count = root["@odata.count"];
  } else {
    throw providerResponseError("SAP S/4HANA Cloud response did not contain an entity collection");
  }
  const total = typeof count === "string" || typeof count === "number" ? Number(count) : Number.NaN;
  return compactObject({
    records,
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
