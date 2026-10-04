import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { B1Context } from "./runtime.ts";

import { compactObject, optionalInteger, optionalNumber, optionalRecord, optionalString } from "../../core/cast.ts";
import { providerInputError, providerResponseError, requiredInputString } from "../provider-runtime.ts";
import { b1Request, runB1Session, serviceRoot } from "./runtime.ts";

type B1Handler = (input: Record<string, unknown>, context: B1Context) => Promise<unknown>;

const defaultPageSize = 50;
const maxPageSize = 1000;
const reservedEntitySets = new Set(["login", "logout"]);

export const sapBusinessOneHandlers: ProviderActionHandlers<"sap_business_one", B1Handler> = {
  list_business_partners: (input, context) => queryCollection(context, "BusinessPartners", input),
  get_business_partner: (input, context) =>
    getEntity(context, "BusinessPartners", stringKey(input.key, "key"), input.select),
  list_items: (input, context) => queryCollection(context, "Items", input),
  get_item: (input, context) => getEntity(context, "Items", stringKey(input.key, "key"), input.select),
  list_sales_orders: (input, context) => queryCollection(context, "Orders", input),
  get_sales_order: (input, context) => getEntity(context, "Orders", integerKey(input.key, "key"), input.select),
  list_invoices: (input, context) => queryCollection(context, "Invoices", input),
  list_purchase_orders: (input, context) => queryCollection(context, "PurchaseOrders", input),
  query_entity_set: (input, context) =>
    queryCollection(context, requiredEntitySet(input.entitySet), input, optionalString(input.expand)),
  fetch_next_page: (input, context) => fetchNextPage(context, input),
  create_business_partner: (input, context) => createBusinessPartner(context, input),
  create_sales_order: (input, context) => createSalesOrder(context, input),
  update_entity: (input, context) => updateEntity(context, input),
};

function requiredEntitySet(value: unknown): string {
  const entitySet = requiredInputString(value, "entitySet");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entitySet) || reservedEntitySets.has(entitySet.toLowerCase())) {
    throw providerInputError("entitySet must be an entity set name such as BusinessPartners");
  }
  return entitySet;
}

/** Quote a string key for an OData key predicate: embedded single quotes are doubled, the rest percent-encoded. */
export function stringKey(value: unknown, fieldName: string): string {
  const key = requiredInputString(value, fieldName);
  return encodeURIComponent(`'${key.replaceAll("'", "''")}'`);
}

function integerKey(value: unknown, fieldName: string): string {
  const key = optionalInteger(value);
  if (key === undefined || key < 0) throw providerInputError(`${fieldName} must be a non-negative integer`);
  return String(key);
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

function pageSizeHeaders(pageSize: number | undefined): Record<string, string> {
  return { prefer: `odata.maxpagesize=${pageSize ?? defaultPageSize}` };
}

async function queryCollection(
  context: B1Context,
  entitySet: string,
  input: Record<string, unknown>,
  expand?: string,
): Promise<unknown> {
  const top = readIntegerOption(input.top, "top", 1, maxPageSize);
  const skip = readIntegerOption(input.skip, "skip", 0);
  const pageSize = readIntegerOption(input.pageSize, "pageSize", 1, maxPageSize);
  const parts: [string, string | undefined][] = [
    ["$filter", optionalString(input.filter)],
    ["$select", optionalString(input.select)],
    ["$expand", expand],
    ["$orderby", optionalString(input.orderby)],
    ["$top", top === undefined ? undefined : String(top)],
    ["$skip", skip === undefined || skip === 0 ? undefined : String(skip)],
  ];
  if (input.includeCount === true) {
    parts.push(context.apiVersion === "v1" ? ["$inlinecount", "allpages"] : ["$count", "true"]);
  }
  const query = queryString(parts);
  const url = `${serviceRoot(context)}/${entitySet}${query ? `?${query}` : ""}`;
  const { payload } = await runB1Session(context, (session, signal) =>
    b1Request(context, session, { method: "GET", url, headers: pageSizeHeaders(pageSize ?? top), signal }),
  );
  return shapeCollection(payload, context);
}

async function getEntity(context: B1Context, entitySet: string, key: string, select: unknown): Promise<unknown> {
  const query = queryString([["$select", optionalString(select)]]);
  const url = `${serviceRoot(context)}/${entitySet}(${key})${query ? `?${query}` : ""}`;
  const { payload } = await runB1Session(context, (session, signal) =>
    b1Request(context, session, { method: "GET", url, signal }),
  );
  return { entity: unwrapEntity(payload) };
}

async function fetchNextPage(context: B1Context, input: Record<string, unknown>): Promise<unknown> {
  const link = requiredInputString(input.nextLink, "nextLink");
  const url = rebaseNextLink(link, context);
  const pageSize = readIntegerOption(input.pageSize, "pageSize", 1, maxPageSize);
  const { payload } = await runB1Session(context, (session, signal) =>
    b1Request(context, session, { method: "GET", url, headers: pageSizeHeaders(pageSize), signal }),
  );
  return shapeCollection(payload, context);
}

/**
 * The Service Layer sends next links relative to the service root (`Items?$skip=20`); a host
 * may also be an internal name. Resolve against the configured origin and keep only path and query.
 */
function rebaseNextLink(link: string, context: B1Context): string {
  let parsed: URL;
  try {
    parsed = new URL(link, `${serviceRoot(context)}/`);
  } catch {
    throw providerInputError("nextLink must be a link returned by a previous query");
  }
  if (!parsed.pathname.startsWith("/b1s/")) {
    throw providerInputError("nextLink must point into the Service Layer (/b1s/...)");
  }
  return `${context.origin}${parsed.pathname}${parsed.search}`;
}

async function createBusinessPartner(context: B1Context, input: Record<string, unknown>): Promise<unknown> {
  const extra = optionalRecord(input.additionalFields) ?? {};
  const body = {
    ...extra,
    ...compactObject({
      CardCode: optionalString(input.CardCode),
      CardName: requiredInputString(input.CardName, "CardName"),
      CardType: optionalString(input.CardType) ?? "cCustomer",
      GroupCode: optionalInteger(input.GroupCode),
      Currency: optionalString(input.Currency),
      Phone1: optionalString(input.Phone1),
      EmailAddress: optionalString(input.EmailAddress),
      FederalTaxID: optionalString(input.FederalTaxID),
    }),
  };
  return createEntity(context, "BusinessPartners", body);
}

async function createSalesOrder(context: B1Context, input: Record<string, unknown>): Promise<unknown> {
  if (!Array.isArray(input.DocumentLines) || input.DocumentLines.length === 0) {
    throw providerInputError("DocumentLines must contain at least one line");
  }
  const lines = input.DocumentLines.map((raw, index) => {
    const line = optionalRecord(raw);
    const quantity = optionalNumber(line?.Quantity);
    if (!line || quantity === undefined || quantity <= 0) {
      throw providerInputError(`DocumentLines[${index}] needs an ItemCode and a Quantity above zero`);
    }
    return compactObject({
      ItemCode: requiredInputString(line.ItemCode, `DocumentLines[${index}].ItemCode`),
      Quantity: quantity,
      Price: optionalNumber(line.Price),
      WarehouseCode: optionalString(line.WarehouseCode),
    });
  });
  const body = compactObject({
    CardCode: requiredInputString(input.CardCode, "CardCode"),
    DocDueDate: requiredInputString(input.DocDueDate, "DocDueDate"),
    DocDate: optionalString(input.DocDate),
    NumAtCard: optionalString(input.NumAtCard),
    Comments: optionalString(input.Comments),
    DocumentLines: lines,
  });
  return createEntity(context, "Orders", body);
}

async function createEntity(context: B1Context, entitySet: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${serviceRoot(context)}/${entitySet}`;
  const result = await runB1Session(context, (session, signal) =>
    b1Request(context, session, { method: "POST", url, body, signal }),
  );
  return compactObject({
    status: result.status,
    entity: result.payload === null ? undefined : unwrapEntity(result.payload),
  });
}

async function updateEntity(context: B1Context, input: Record<string, unknown>): Promise<unknown> {
  const entitySet = requiredEntitySet(input.entitySet);
  const key = typeof input.key === "number" ? integerKey(input.key, "key") : stringKey(input.key, "key");
  const body = optionalRecord(input.body);
  if (!body || Object.keys(body).length === 0) {
    throw providerInputError("body must be a non-empty object of properties to change");
  }
  const etag = optionalString(input.etag);
  const url = `${serviceRoot(context)}/${entitySet}(${key})`;
  const result = await runB1Session(context, (session, signal) =>
    b1Request(context, session, {
      method: "PATCH",
      url,
      body,
      headers: etag ? { "if-match": etag } : {},
      signal,
    }),
  );
  return compactObject({
    updated: true,
    status: result.status,
    entity: result.payload === null ? undefined : unwrapEntity(result.payload),
  });
}

function unwrapEntity(payload: unknown): Record<string, unknown> {
  const root = optionalRecord(payload);
  if (!root) throw providerResponseError("SAP Business One record response is missing");
  const { "@odata.context": _v4Context, "odata.metadata": _v1Context, ...entity } = root;
  return entity;
}

function toPathLink(link: string, context: B1Context): string {
  try {
    const url = new URL(link, `${serviceRoot(context)}/`);
    return `${url.pathname}${url.search}`;
  } catch {
    return link;
  }
}

/** Normalize a v2 (`@odata.*`) or v1 (`odata.*`) collection response. */
function shapeCollection(payload: unknown, context: B1Context): Record<string, unknown> {
  const root = optionalRecord(payload);
  if (!root || !Array.isArray(root.value)) {
    throw providerResponseError("SAP Business One response did not contain a record collection");
  }
  const next = root["@odata.nextLink"] ?? root["odata.nextLink"];
  const count = root["@odata.count"] ?? root["odata.count"];
  const total = typeof count === "string" || typeof count === "number" ? Number(count) : Number.NaN;
  return compactObject({
    records: root.value,
    nextLink: typeof next === "string" && next ? toPathLink(next, context) : undefined,
    totalCount: Number.isFinite(total) ? total : undefined,
  });
}
