import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { AribaContext } from "./runtime.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalRecord,
  optionalString,
  optionalStringArray,
} from "../../core/cast.ts";
import {
  defineProviderExecutors,
  defineProviderProxy,
  providerInputError,
  providerProxyEndpointPrefixes,
  requiredInputString,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  aribaApiHeaders,
  aribaRequest,
  createAribaContext,
  resolveAribaConnection,
  resolveRealm,
  shapeAribaPage,
  validateAribaCredentials,
} from "./runtime.ts";

const service = "sap_ariba";

const reportingBase = "/api/procurement-reporting-details/v2/prod";
const viewManagementBase = "/api/procurement-reporting-view-management/v2/prod";
const approvalBase = "/api/approval/v2/prod";
const supplierBase = "/api/supplierdatapagination/v4/prod";

const reportingFamily = "Operational Reporting for Procurement API";
const approvalFamily = "Document Approval API";
const supplierFamily = "Supplier Data API with Pagination";

type AribaHandler = (input: Record<string, unknown>, context: AribaContext) => Promise<unknown>;

const approvableTypes = ["requisitions", "invoices", "userprofiles"] as const;

function pathSegment(value: unknown, fieldName: string): string {
  const text = requiredInputString(value, fieldName);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(text) || text === "." || text === "..") {
    throw providerInputError(`${fieldName} may only contain letters, digits, dots, colons, hyphens and underscores`);
  }
  return encodeURIComponent(text);
}

function approvableType(value: unknown): string {
  const type = requiredInputString(value, "approvableType");
  if (!(approvableTypes as readonly string[]).includes(type)) {
    throw providerInputError(`approvableType must be one of ${approvableTypes.join(", ")}`);
  }
  return type;
}

/** Quote a value for an OData `$filter` string literal; quotes cannot be escaped reliably, so they are refused. */
function filterLiteral(value: string, fieldName: string): string {
  if (value.includes("'")) throw providerInputError(`${fieldName} must not contain a single quote`);
  return `'${value}'`;
}

function integerInRange(value: unknown, fieldName: string, minimum: number, maximum?: number): number | undefined {
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

/** Validate a relative `/api/...` path for query_resource. */
function resourcePath(value: unknown): string {
  const raw = requiredInputString(value, "path");
  const path = `/${raw.replace(/^\/+/u, "")}`;
  if (
    !path.startsWith("/api/") ||
    !/^\/[A-Za-z0-9._~\-/%$:@]+$/u.test(path) ||
    path.includes("//") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw providerInputError("path must be a plain relative URL path starting with /api/, without a query string");
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

const handlers: ProviderActionHandlers<typeof service, AribaHandler> = {
  async list_view_templates(input, context) {
    const payload = await aribaRequest(context, {
      method: "GET",
      path: `${viewManagementBase}/viewTemplates`,
      query: {
        realm: resolveRealm(context, input),
        documentType: optionalString(input.documentType),
        status: optionalString(input.status),
      },
      family: "Operational Reporting for Procurement (View Management) API",
    });
    return { templates: shapeAribaPage(payload).records };
  },

  async run_report_view(input, context) {
    const name = pathSegment(input.viewTemplateName, "viewTemplateName");
    const filters = input.filters === undefined ? undefined : optionalRecord(input.filters);
    if (input.filters !== undefined && !filters) throw providerInputError("filters must be an object");
    const payload = await aribaRequest(context, {
      method: "GET",
      path: `${reportingBase}/views/${name}`,
      query: {
        realm: resolveRealm(context, input),
        filters: filters && Object.keys(filters).length > 0 ? JSON.stringify(filters) : undefined,
        pageToken: optionalString(input.pageToken),
      },
      family: reportingFamily,
    });
    return shapeAribaPage(payload);
  },

  async list_pending_approvables(input, context) {
    const type = optionalString(input.approvableType);
    const user = optionalString(input.user);
    if (type && user) {
      throw providerInputError("Filter by approvableType or by user, not both: SAP Ariba applies only one of them.");
    }
    const filter = type
      ? `approvableType eq ${filterLiteral(approvableType(type), "approvableType")}`
      : user
        ? `user eq ${filterLiteral(user, "user")}`
        : undefined;
    const top = integerInRange(input.top, "top", 1, 100);
    const skip = integerInRange(input.skip, "skip", 0);
    const payload = await aribaRequest(context, {
      method: "GET",
      path: `${approvalBase}/pendingApprovables`,
      query: {
        realm: resolveRealm(context, input),
        $filter: filter,
        $top: top === undefined ? undefined : String(top),
        $skip: skip === undefined ? undefined : String(skip),
        $count: "true",
      },
      family: approvalFamily,
    });
    const { records, totalCount } = shapeAribaPage(payload);
    return { records, ...(totalCount === undefined ? {} : { totalCount }) };
  },

  async get_approvable(input, context) {
    const type = approvableType(input.approvableType);
    const id = pathSegment(input.approvableId, "approvableId");
    const payload = await aribaRequest(context, {
      method: "GET",
      path: `${approvalBase}/${type}/${id}`,
      query: { realm: resolveRealm(context, input) },
      family: approvalFamily,
    });
    return { approvable: optionalRecord(payload) ?? {} };
  },

  async decide_approvable(input, context) {
    const type = approvableType(input.approvableType);
    const id = pathSegment(input.approvableId, "approvableId");
    const decision = requiredInputString(input.decision, "decision");
    if (decision !== "approve" && decision !== "deny") throw providerInputError("decision must be approve or deny");
    const comment = optionalString(input.comment);
    const body: Record<string, unknown> = { state: decision === "approve" ? "Approved" : "Denied" };
    if (comment) {
      body.comment = {
        text: comment,
        visibleToSupplier: String(optionalBoolean(input.commentVisibleToSupplier) ?? false),
      };
    }
    const payload = await aribaRequest(context, {
      method: "PATCH",
      path: `${approvalBase}/${type}/${id}`,
      query: {
        realm: resolveRealm(context, input),
        user: requiredInputString(input.user, "user"),
        passwordadapter: optionalString(input.passwordAdapter),
      },
      body,
      family: approvalFamily,
    });
    const response = optionalRecord(payload);
    return { submitted: true, ...(response ? { response } : {}) };
  },

  async query_suppliers(input, context) {
    const list = (value: unknown, fieldName: string): string[] | undefined => {
      if (value === undefined || value === null) return undefined;
      const items = optionalStringArray(value);
      if (!items) throw providerInputError(`${fieldName} must be an array of strings`);
      return items.length > 0 ? items : undefined;
    };
    const preferred = Array.isArray(input.preferredLevels)
      ? input.preferredLevels.map((level) => integerInRange(level, "preferredLevels", 1, 5)!)
      : undefined;
    const pageLimit = integerInRange(input.pageLimit, "pageLimit", 1, 500);
    const body: Record<string, unknown> = {
      outputFormat: "JSON",
      withQuestionnaire: optionalBoolean(input.withQuestionnaire) ?? false,
      ...(pageLimit === undefined ? {} : { pageLimit }),
    };
    const fields: [string, unknown][] = [
      ["smVendorIds", list(input.smVendorIds, "smVendorIds")],
      ["registrationStatusList", list(input.registrationStatuses, "registrationStatuses")],
      ["qualificationStatusList", list(input.qualificationStatuses, "qualificationStatuses")],
      ["preferredLevelList", preferred && preferred.length > 0 ? preferred : undefined],
      ["regionList", list(input.regions, "regions")],
      ["categoryList", list(input.categories, "categories")],
      ["businessUnitList", list(input.businessUnits, "businessUnits")],
    ];
    for (const [key, value] of fields) if (value !== undefined) body[key] = value;
    const payload = await aribaRequest(context, {
      method: "POST",
      path: `${supplierBase}/vendorDataRequests`,
      query: {
        realm: resolveRealm(context, input),
        $skip: optionalString(input.pageToken),
        $count: "true",
      },
      body,
      family: supplierFamily,
    });
    return shapeAribaPage(payload);
  },

  async query_resource(input, context) {
    const query = flatQuery(input.query);
    if (query.realm === undefined && context.realm) query.realm = context.realm;
    const payload = await aribaRequest(context, {
      method: "GET",
      path: resourcePath(input.path),
      query,
      family: "requested API",
    });
    return { data: payload };
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<AribaContext>({
  service,
  handlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<AribaContext> {
    const credential = await requireCustomCredential(context, service);
    return createAribaContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "SAP Ariba request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return resolveAribaConnection(credential.values).apiBase;
  },
  auth: { type: "none" },
  allowedEndpoint: providerProxyEndpointPrefixes("/api"),
  sensitiveHeaders: ["apikey", "x-ariba-network-id"],
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const ariba = await createAribaContext(credential.values, fetcher, context.signal);
    headers.set("authorization", ariba.authorization);
    for (const [name, value] of Object.entries(aribaApiHeaders(ariba))) headers.set(name, value);
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateAribaCredentials(input.values, fetcher, signal);
  },
};
