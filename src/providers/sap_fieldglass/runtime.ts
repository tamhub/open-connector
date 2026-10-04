import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import {
  compactObject,
  optionalInteger,
  optionalRecord,
  optionalString,
  optionalScalarString,
} from "../../core/cast.ts";
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

type RequestPhase = "validate" | "execute";

export interface FieldglassContext {
  /** API root, for example `https://acme-fgvms.com/api`. */
  baseUrl: string;
  /** Complete `Authorization` header value (`Bearer <token>`). */
  authorization: string;
  /** Optional `X-ApplicationKey`; some Fieldglass APIs do not require it. */
  appKey: string | undefined;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type FieldglassHandler = (input: Record<string, unknown>, context: FieldglassContext) => Promise<unknown>;

const providerLabel = "SAP Fieldglass";
// Any host on SAP Fieldglass domains: `<tenant>-fgvms.com` style hosts and subdomains of fgvms.com, fieldglass.net and fieldglass.eu.
const allowedHostPattern =
  /^(?:[a-z0-9_-]+-(?:auth\.)?fgvms\.com|(?:[a-z0-9_-]+\.)+(?:fgvms\.com|fieldglass\.net|fieldglass\.eu))$/u;
const defaultMaxRecords = 500;
const maxRecordsLimit = 5000;
const connectorMaxBytes = 10 * 1024 * 1024;

/**
 * Normalize the `domain` credential into a bare, allow-listed Fieldglass host.
 * Accepts a host with or without `https://` and drops any path, query or trailing slash.
 */
export function normalizeFieldglassDomain(value: unknown): string {
  const raw = requiredInputString(value, "domain");
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw);
  if (hasScheme && !/^https:\/\//iu.test(raw)) throw providerInputError("domain must use https");
  const url = assertPublicHttpUrl(hasScheme ? raw : `https://${raw}`, {
    fieldName: "domain",
    createError: providerInputError,
  });
  if (url.username || url.password) throw providerInputError("domain must not include credentials");
  if (url.port) throw providerInputError("domain must not include a port");
  const host = url.hostname.toLowerCase();
  if (!allowedHostPattern.test(host)) {
    throw providerInputError(
      "domain must be a Fieldglass environment host on fgvms.com, fieldglass.net or fieldglass.eu, such as <tenant>-fgvms.com, auth.fieldglass.net or sso.fieldglass.eu",
    );
  }
  return host;
}

interface FieldglassCredentials {
  domain: string;
  clientId: string;
  clientSecret: string;
  appKey: string | undefined;
}

function readCredentials(values: Record<string, string>): FieldglassCredentials {
  const clientSecret = values.clientSecret;
  if (!clientSecret) throw providerInputError("clientSecret is required.");
  const appKey = values.appKey?.trim() || undefined;
  return {
    domain: normalizeFieldglassDomain(values.domain),
    clientId: requiredInputString(values.clientId, "clientId"),
    clientSecret,
    appKey,
  };
}

function applicationKeyHeader(appKey: string | undefined): Record<string, string> {
  return appKey ? { "x-applicationkey": appKey } : {};
}

export function fieldglassApiBase(domain: string): string {
  return `https://${domain}/api`;
}

/** Exchange the client credentials for a short-lived bearer token. Called once per action. */
async function exchangeToken(
  credentials: FieldglassCredentials,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: RequestPhase,
): Promise<string> {
  const url = `${fieldglassApiBase(credentials.domain)}/oauth2/v2.0/token?grant_type=client_credentials&response_type=token`;
  return runProviderRequest({ signal, label: `${providerLabel} token` }, async (requestSignal) => {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: basicAuthorizationHeader(`${credentials.clientId}:${credentials.clientSecret}`),
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": providerUserAgent,
        ...applicationKeyHeader(credentials.appKey),
      },
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP Fieldglass token error response");
      const message = extractFieldglassError(text, response.statusText);
      throw new ProviderRequestError(
        phase === "validate" && response.status < 500 && response.status !== 429 ? 400 : response.status,
        `${providerLabel} token request failed: ${message}`,
        withRetryAfterSeconds(response),
      );
    }
    const text = await readProviderTextBody(response, "SAP Fieldglass token response");
    const payload = optionalRecord(
      parseProviderJsonBodyText(text, {
        emptyBody: null,
        invalidJsonMessage: `${providerLabel} returned a malformed token response`,
      }),
    );
    const accessToken = optionalString(payload?.access_token);
    if (!accessToken) throw providerResponseError(`${providerLabel} token response did not include an access_token`);
    return accessToken;
  });
}

export async function createFieldglassContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  phase: RequestPhase = "execute",
): Promise<FieldglassContext> {
  const credentials = readCredentials(values);
  const accessToken = await exchangeToken(credentials, fetcher, signal, phase);
  return {
    baseUrl: fieldglassApiBase(credentials.domain),
    authorization: `Bearer ${accessToken}`,
    appKey: credentials.appKey,
    fetcher,
    signal,
  };
}

/** Token exchange is the cheap probe: it proves host, user, secret and application key together. */
export async function validateFieldglassCredentials(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  await createFieldglassContext(values, fetcher, signal, "validate");
  const domain = normalizeFieldglassDomain(values.domain);
  const clientId = values.clientId!.trim();
  return {
    profile: { accountId: `${domain}+${clientId}`, displayName: `${providerLabel} (${domain})` },
    grantedScopes: [],
    metadata: { domain, apiBase: fieldglassApiBase(domain) },
  };
}

/** Pull a readable message out of a Fieldglass JSON error (HEADER.Details, message, error) or plain text. */
export function extractFieldglassError(text: string, fallback: string): string {
  const defaultMessage = fallback || `${providerLabel} request failed`;
  const trimmed = text.trim();
  if (!trimmed) return defaultMessage;
  try {
    const root = optionalRecord(JSON.parse(trimmed) as unknown);
    if (root) {
      const header = optionalRecord(root.HEADER);
      const error = root.error;
      return (
        optionalString(root.error_description) ??
        optionalString(optionalRecord(error)?.message) ??
        optionalString(error) ??
        optionalString(root.message) ??
        optionalString(header?.Details) ??
        defaultMessage
      );
    }
  } catch {
    // Not JSON: fall through to plain text.
  }
  return trimmed.startsWith("<") ? defaultMessage : trimmed.slice(0, 500);
}

interface RequestOptions {
  method: "GET" | "POST";
  /** Path relative to the API root, starting with `/`. */
  path: string;
  query?: [string, string | undefined][];
  maxBytes?: number;
}

/** Send one authorized request and return the bounded response text with its status and content type. */
async function fieldglassRequest(
  context: FieldglassContext,
  options: RequestOptions,
): Promise<{ status: number; text: string; contentType: string }> {
  const search = (options.query ?? [])
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const url = `${context.baseUrl}${options.path}${search ? `?${search}` : ""}`;
  return runProviderRequest({ signal: context.signal, label: providerLabel }, async (signal) => {
    const response = await context.fetcher(url, {
      method: options.method,
      headers: {
        accept: "application/json, text/csv;q=0.9, */*;q=0.5",
        authorization: context.authorization,
        "user-agent": providerUserAgent,
        ...applicationKeyHeader(context.appKey),
        ...(options.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      signal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP Fieldglass error response");
      throw new ProviderRequestError(
        response.status || 500,
        extractFieldglassError(text, response.statusText),
        withRetryAfterSeconds(response),
      );
    }
    const text = await readProviderTextBody(response, "SAP Fieldglass response", options.maxBytes);
    return { status: response.status, text, contentType: response.headers.get("content-type") ?? "" };
  });
}

function parseJsonOrUndefined(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function requiredModuleId(value: unknown): string {
  const id = requiredInputString(value, "moduleId");
  if (!/^[0-9]{1,6}$/u.test(id)) throw providerInputError("moduleId must be a numeric Fieldglass module id such as 40");
  return id;
}

function requiredIdSegment(value: unknown, fieldName: string): string {
  const id = requiredInputString(value, fieldName);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
    throw providerInputError(`${fieldName} may only contain letters, digits, hyphens and underscores`);
  }
  return id;
}

/** Fieldglass wraps lists as `{ HEADER, PAYLOAD: [...] }`; return the PAYLOAD entries. */
function readPayload(text: string): Record<string, unknown>[] {
  const root = optionalRecord(parseJsonOrUndefined(text));
  if (!root) throw providerResponseError(`${providerLabel} returned a response that is not JSON`);
  const header = optionalRecord(root.HEADER);
  const headerStatus = optionalString(header?.Status);
  if (headerStatus && headerStatus.toLowerCase() !== "ok") {
    throw new ProviderRequestError(
      400,
      optionalString(header?.Details) ?? `${providerLabel} reported status ${headerStatus}`,
    );
  }
  const payload = root.PAYLOAD;
  if (payload === undefined || payload === null) return [];
  if (!Array.isArray(payload)) throw providerResponseError(`${providerLabel} PAYLOAD was not a list`);
  return payload.map((entry) => optionalRecord(entry) ?? {});
}

function shapeApprovalItem(entry: Record<string, unknown>): Record<string, unknown> {
  const attributes = optionalRecord(entry.Attributes) ?? {};
  return compactObject({
    moduleId: optionalScalarString(entry.ModuleID),
    moduleName: optionalString(entry.ModuleName),
    id: optionalScalarString(entry.ID) ?? "",
    reference: optionalScalarString(attributes.ref),
    name: optionalScalarString(attributes.name),
    amount: optionalScalarString(attributes.amount),
    currency: optionalScalarString(attributes.uom),
    startDate: optionalScalarString(attributes.startDate),
    status: optionalScalarString(attributes.status),
    attributes,
  });
}

function forUserQuery(input: Record<string, unknown>): [string, string | undefined] {
  return ["for_user", optionalString(input.forUser)];
}

async function listPendingApprovals(context: FieldglassContext, input: Record<string, unknown>): Promise<unknown> {
  const moduleId = input.moduleId === undefined ? undefined : requiredModuleId(input.moduleId);
  const { text } = await fieldglassRequest(context, {
    method: "GET",
    path: moduleId ? `/v1/approvals/module_${moduleId}` : "/v1/approvals",
    query: [forUserQuery(input)],
  });
  const items = readPayload(text).map(shapeApprovalItem);
  return { count: items.length, items };
}

async function getApprovalItem(context: FieldglassContext, input: Record<string, unknown>): Promise<unknown> {
  const moduleId = requiredModuleId(input.moduleId);
  const workItemId = requiredIdSegment(input.workItemId, "workItemId");
  const { text } = await fieldglassRequest(context, {
    method: "GET",
    path: `/v1/approvals/module_${moduleId}/${workItemId}`,
  });
  const [first] = readPayload(text);
  if (!first) throw new ProviderRequestError(404, "Work item not found or no longer awaiting approval");
  return { item: shapeApprovalItem(first) };
}

async function listRejectionReasons(context: FieldglassContext, input: Record<string, unknown>): Promise<unknown> {
  const moduleId = requiredModuleId(input.moduleId);
  const { text } = await fieldglassRequest(context, {
    method: "GET",
    path: `/v1/approvals/reject_reasons/module_${moduleId}`,
  });
  const reasons = readPayload(text).map((entry) => {
    const attributes = optionalRecord(entry.Attributes);
    const others = optionalRecord(attributes?.others);
    return { id: optionalScalarString(entry.ID) ?? "", description: optionalScalarString(others?.description) ?? "" };
  });
  return { reasons };
}

async function decideApproval(
  context: FieldglassContext,
  input: Record<string, unknown>,
  action: "approve" | "reject",
): Promise<unknown> {
  const moduleId = requiredModuleId(input.moduleId);
  const workItemId = requiredIdSegment(input.workItemId, "workItemId");
  const query: [string, string | undefined][] = [
    ["reasonId", action === "reject" ? requiredIdSegment(input.reasonId, "reasonId") : undefined],
    ["comments", optionalString(input.comments)],
    forUserQuery(input),
  ];
  const { text } = await fieldglassRequest(context, {
    method: "POST",
    path: `/v1/approvals/module_${moduleId}/${workItemId}/action/${action}`,
    query,
  });
  const response = optionalRecord(parseJsonOrUndefined(text));
  const header = optionalRecord(response?.HEADER);
  const headerStatus = optionalString(header?.Status);
  if (headerStatus && headerStatus.toLowerCase() !== "ok") {
    throw new ProviderRequestError(400, optionalString(header?.Details) ?? `${providerLabel} rejected the decision`);
  }
  return action === "approve"
    ? compactObject({ approved: true, response })
    : compactObject({ rejected: true, response });
}

/** Parse RFC 4180 style CSV (quoted fields, doubled quotes, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

function csvToRecords(text: string): Record<string, unknown>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const names = header.map((name, index) => name.trim() || `column_${index + 1}`);
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? ""])));
}

async function runDownloadConnector(context: FieldglassContext, input: Record<string, unknown>): Promise<unknown> {
  const connectorName = requiredInputString(input.connectorName, "connectorName");
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(connectorName) || connectorName === "." || connectorName === "..") {
    throw providerInputError("connectorName may only contain letters, digits, dots, hyphens and underscores");
  }
  const rawLimit = input.maxRecords;
  const limit = rawLimit === undefined || rawLimit === null ? defaultMaxRecords : optionalInteger(rawLimit);
  if (limit === undefined || limit < 1 || limit > maxRecordsLimit) {
    throw providerInputError(`maxRecords must be an integer between 1 and ${maxRecordsLimit}`);
  }
  const parameters = input.parameters;
  if (parameters !== undefined && (!Array.isArray(parameters) || parameters.length > 20)) {
    throw providerInputError("parameters must be a list of at most 20 strings");
  }
  const query: [string, string | undefined][] = (parameters ?? []).map((value, index) => {
    const text = optionalScalarString(value);
    if (text === undefined) throw providerInputError("parameters must contain only strings");
    return [`__p${index + 1}`, text];
  });
  const { text, contentType } = await fieldglassRequest(context, {
    method: "GET",
    path: `/vc/connector/${connectorName}`,
    query,
    maxBytes: connectorMaxBytes,
  });

  const json = parseJsonOrUndefined(text);
  if (json !== undefined) {
    const root = optionalRecord(json);
    const rows = Array.isArray(json) ? json : Array.isArray(root?.PAYLOAD) ? root.PAYLOAD : root ? [root] : [];
    return shapeRows(
      "json",
      rows.map((row) => optionalRecord(row) ?? { value: row }),
      limit,
    );
  }
  const looksLikeCsv = /csv/iu.test(contentType) || /^[^\n]*,[^\n]*\n/u.test(text);
  if (looksLikeCsv && text.trim()) return shapeRows("csv", csvToRecords(text), limit);
  return { format: "text", records: [], totalRecords: 0, truncated: false, text: text.slice(0, 20_000) };
}

function shapeRows(format: "json" | "csv", rows: Record<string, unknown>[], limit: number): Record<string, unknown> {
  return {
    format,
    records: rows.slice(0, limit),
    totalRecords: rows.length,
    truncated: rows.length > limit,
  };
}

/** Normalize a caller-supplied path to a plain `/segment/segment` path under `/api`. */
export function normalizeResourcePath(value: unknown): string {
  let path = requiredInputString(value, "path");
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path) || path.startsWith("//")) {
    throw providerInputError("path must be relative to /api, not a URL");
  }
  path = `/${path.replace(/^\/+/u, "")}`;
  if (path === "/api" || path.startsWith("/api/")) path = path.slice(4) || "/";
  path = path.replace(/\/+$/u, "");
  if (!path || path === "/") throw providerInputError("path must name a resource under /api");
  if (!/^\/[A-Za-z0-9._~\-/;=]+$/u.test(path) || path.includes("//") || path.split("/").some((part) => part === "..")) {
    throw providerInputError("path may only contain letters, digits and . _ ~ - / ; = characters");
  }
  return path;
}

async function queryResource(context: FieldglassContext, input: Record<string, unknown>): Promise<unknown> {
  const path = normalizeResourcePath(input.path);
  const rawQuery = input.query;
  const queryRecord = rawQuery === undefined || rawQuery === null ? {} : optionalRecord(rawQuery);
  if (!queryRecord) throw providerInputError("query must be an object of strings, numbers or booleans");
  const query = Object.entries(queryRecord).map(([key, value]): [string, string] => {
    const text = typeof value === "boolean" ? String(value) : optionalScalarString(value);
    if (text === undefined) throw providerInputError(`query.${key} must be a string, number or boolean`);
    return [key, text];
  });
  const { status, text } = await fieldglassRequest(context, { method: "GET", path, query });
  const data = parseJsonOrUndefined(text) ?? (text.trim() ? text : undefined);
  return compactObject({ status, data });
}

export const fieldglassHandlers: ProviderActionHandlers<"sap_fieldglass", FieldglassHandler> = {
  list_pending_approvals: (input, context) => listPendingApprovals(context, input),
  get_approval_item: (input, context) => getApprovalItem(context, input),
  list_rejection_reasons: (input, context) => listRejectionReasons(context, input),
  approve_item: (input, context) => decideApproval(context, input, "approve"),
  reject_item: (input, context) => decideApproval(context, input, "reject"),
  run_download_connector: (input, context) => runDownloadConnector(context, input),
  query_resource: (input, context) => queryResource(context, input),
};
