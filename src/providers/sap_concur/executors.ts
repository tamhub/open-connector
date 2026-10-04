import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { ConcurContext } from "./runtime.ts";

import { optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  defineProviderExecutors,
  defineProviderProxy,
  providerInputError,
  requiredInputString,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  concurKnownHosts,
  concurRequest,
  createConcurContext,
  nextOffset,
  refreshConcurToken,
  resolveConcurConnection,
  validatedGeolocation,
  validateConcurCredentials,
} from "./runtime.ts";

const service = "sap_concur";

const identityFamily = "Identity API";
const expenseFamily = "Expense API";

type ConcurHandler = (input: Record<string, unknown>, context: ConcurContext) => Promise<unknown>;

/** Concur ids are UUIDs or short alphanumeric ids; keep path segments strictly plain. */
function pathSegment(value: unknown, fieldName: string): string {
  const text = requiredInputString(value, fieldName);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(text) || text === "." || text === "..") {
    throw providerInputError(`${fieldName} may only contain letters, digits, dots, colons, hyphens and underscores`);
  }
  return encodeURIComponent(text);
}

function integerInRange(value: unknown, fieldName: string, minimum: number, maximum?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const number = optionalInteger(value);
  if (number === undefined || number < minimum || (maximum !== undefined && number > maximum)) {
    throw providerInputError(
      maximum === undefined
        ? `${fieldName} must be an integer of at least ${minimum}`
        : `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return String(number);
}

function dateParam(value: unknown, fieldName: string): string | undefined {
  const text = optionalString(value);
  if (text === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?)?$/u.test(text)) {
    throw providerInputError(`${fieldName} must be yyyy-MM-dd or yyyy-MM-ddTHH:mm:ss`);
  }
  return text;
}

function codeList(value: unknown, fieldName: string): string | undefined {
  const text = optionalString(value);
  if (text === undefined) return undefined;
  if (!/^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$/u.test(text)) {
    throw providerInputError(`${fieldName} must be a status code or comma-separated status codes`);
  }
  return text;
}

function loginParam(value: unknown, fieldName: string): string | undefined {
  const text = optionalString(value);
  if (text === undefined) return undefined;
  if (text.length > 255 || /[\r\n]/u.test(text)) throw providerInputError(`${fieldName} is not a valid login id`);
  return text;
}

function offsetParam(value: unknown): string | undefined {
  const text = optionalString(value);
  if (text === undefined) return undefined;
  if (!/^[A-Za-z0-9_\-=.%+/]+$/u.test(text)) throw providerInputError("offset is not a valid paging token");
  return text;
}

/** Validate a relative API path for query_resource. */
function resourcePath(value: unknown): string {
  const raw = requiredInputString(value, "path");
  const path = `/${raw.replace(/^\/+/u, "")}`;
  if (
    !/^\/[A-Za-z0-9._~\-/%$:@]+$/u.test(path) ||
    path.includes("//") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw providerInputError("path must be a plain relative URL path starting with /, without a query string");
  }
  return path;
}

function flatQuery(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = optionalRecord(value);
  if (!record) throw providerInputError("query must be an object");
  const query: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item === undefined || item === null) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw providerInputError(`query.${key} must be a string, number or boolean`);
    }
    query[key] = String(item);
  }
  return query;
}

function recordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = optionalRecord(item);
    return record ? [record] : [];
  });
}

const handlers: ProviderActionHandlers<typeof service, ConcurHandler> = {
  async list_users(input, context) {
    const payload = optionalRecord(
      await concurRequest(context, {
        path: "/profile/identity/v4/Users",
        query: {
          filter: optionalString(input.filter),
          count: integerInRange(input.count, "count", 1, 100),
          startIndex: integerInRange(input.startIndex, "startIndex", 1),
        },
        family: identityFamily,
      }),
    );
    const totalResults = optionalInteger(payload?.totalResults);
    const itemsPerPage = optionalInteger(payload?.itemsPerPage);
    const startIndex = optionalInteger(payload?.startIndex);
    return {
      users: recordList(payload?.Resources),
      ...(totalResults === undefined ? {} : { totalResults }),
      ...(itemsPerPage === undefined ? {} : { itemsPerPage }),
      ...(startIndex === undefined ? {} : { startIndex }),
    };
  },

  async get_user(input, context) {
    const payload = await concurRequest(context, {
      path: `/profile/identity/v4/Users/${pathSegment(input.userId, "userId")}`,
      family: identityFamily,
    });
    return { user: optionalRecord(payload) ?? {} };
  },

  async list_expense_reports(input, context) {
    const payload = optionalRecord(
      await concurRequest(context, {
        path: "/api/v3.0/expense/reports",
        query: {
          user: loginParam(input.user, "user") ?? "ALL",
          approvalStatusCode: codeList(input.approvalStatusCode, "approvalStatusCode"),
          paymentStatusCode: codeList(input.paymentStatusCode, "paymentStatusCode"),
          modifiedDateAfter: dateParam(input.modifiedDateAfter, "modifiedDateAfter"),
          modifiedDateBefore: dateParam(input.modifiedDateBefore, "modifiedDateBefore"),
          createDateAfter: dateParam(input.createDateAfter, "createDateAfter"),
          createDateBefore: dateParam(input.createDateBefore, "createDateBefore"),
          submitDateAfter: dateParam(input.submitDateAfter, "submitDateAfter"),
          submitDateBefore: dateParam(input.submitDateBefore, "submitDateBefore"),
          limit: integerInRange(input.limit, "limit", 1, 100),
          offset: offsetParam(input.offset),
        },
        family: expenseFamily,
      }),
    );
    const next = nextOffset(payload?.NextPage);
    return { reports: recordList(payload?.Items), ...(next ? { nextOffset: next } : {}) };
  },

  async get_expense_report(input, context) {
    const user = loginParam(input.user, "user");
    if (!user || user.toUpperCase() === "ALL") {
      throw providerInputError("user must be the login id of the report owner; ALL is not accepted for one report");
    }
    const payload = await concurRequest(context, {
      path: `/api/v3.0/expense/reports/${pathSegment(input.reportId, "reportId")}`,
      query: { user },
      family: expenseFamily,
    });
    return { report: optionalRecord(payload) ?? {} };
  },

  async list_expense_entries(input, context) {
    const payload = optionalRecord(
      await concurRequest(context, {
        path: "/api/v3.0/expense/entries",
        query: {
          reportID: requiredInputString(input.reportId, "reportId"),
          user: loginParam(input.user, "user") ?? "ALL",
          limit: integerInRange(input.limit, "limit", 1, 100),
          offset: offsetParam(input.offset),
        },
        family: expenseFamily,
      }),
    );
    const next = nextOffset(payload?.NextPage);
    return { entries: recordList(payload?.Items), ...(next ? { nextOffset: next } : {}) };
  },

  async query_resource(input, context) {
    const payload = await concurRequest(context, {
      path: resourcePath(input.path),
      query: flatQuery(input.query),
      family: "requested API",
    });
    return { data: payload };
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<ConcurContext>({
  service,
  handlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<ConcurContext> {
    const credential = await requireCustomCredential(context, service);
    return createConcurContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "SAP Concur request failed",
});

const proxyHosts = concurKnownHosts();

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return `https://${resolveConcurConnection(credential.values).datacenter}`;
  },
  allowedOrigins: proxyHosts.map((host) => `https://${host}`),
  auth: { type: "none" },
  async customizeRequest({ context, headers, url, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const connection = resolveConcurConnection(credential.values);
    const token = await refreshConcurToken(connection, fetcher, context.signal, "execute");
    headers.set("authorization", `Bearer ${token.accessToken}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    // The token response names the host the company's data lives on; follow it only when it is a known Concur host.
    const geolocation = validatedGeolocation(token.apiBase);
    if (geolocation && proxyHosts.includes(new URL(geolocation).hostname)) url.host = new URL(geolocation).host;
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateConcurCredentials(input.values, fetcher, signal);
  },
};
