import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "sap_business_one";

const filterSchema = s.nonEmptyString(
  "OData $filter expression, for example CardType eq 'cCustomer' and Valid eq 'tYES'. String literals use single quotes.",
);
const selectSchema = s.nonEmptyString("Comma-separated property names to return ($select). Omit for all properties.");
const orderbySchema = s.nonEmptyString("OData $orderby expression, for example CardName asc.");
const topSchema = s.integer({
  minimum: 1,
  maximum: 1000,
  description: "Maximum number of records to return in total ($top). Omit to let paging decide.",
});
const skipSchema = s.nonNegativeInteger("Number of records to skip ($skip), for offset paging.");
const pageSizeSchema = s.integer({
  minimum: 1,
  maximum: 1000,
  description:
    "Records per response page (sent as the odata.maxpagesize preference). Defaults to 50. When more records match, nextLink is returned.",
});
const includeCountSchema = s.boolean("Also ask the server for the total number of matching records as totalCount.");
const entitySetSchema = s.nonEmptyString(
  "Service Layer entity set name such as BusinessPartners, Items, Orders, Quotations, Invoices, PurchaseOrders, or JournalEntries.",
);

const collectionOutputSchema = s.object(
  "A page of records.",
  {
    records: s.array(s.unknownObject("One record as returned by the Service Layer."), {
      description: "Records in this page.",
    }),
    nextLink: s.nonEmptyString(
      "Path and query of the next page when more records match; pass it to fetch_next_page. Absent on the last page.",
    ),
    totalCount: s.integer("Total matching records, present only when includeCount was requested."),
  },
  { optional: ["nextLink", "totalCount"] },
);

const createOutputSchema = s.object(
  "Result of the create call.",
  {
    status: s.integer("HTTP status returned by the Service Layer, normally 201."),
    entity: s.unknownObject("The created record, when the Service Layer sends it back."),
  },
  { optional: ["entity"] },
);

const listInputProperties: Record<string, JsonSchema> = {
  filter: s.optional(filterSchema),
  select: s.optional(selectSchema),
  orderby: s.optional(orderbySchema),
  top: s.optional(topSchema),
  skip: s.optional(skipSchema),
  pageSize: s.optional(pageSizeSchema),
  includeCount: s.optional(includeCountSchema),
};

function listAction<const TName extends string>(name: TName, description: string, label: string) {
  return defineProviderAction(service, {
    name,
    operationType: "read",
    description,
    requiredScopes: [],
    followUpActions: ["fetch_next_page"],
    inputSchema: s.object(`Filters and paging for listing ${label}.`, listInputProperties),
    outputSchema: collectionOutputSchema,
  });
}

function getAction<const TName extends string>(name: TName, description: string, label: string, key: JsonSchema) {
  return defineProviderAction(service, {
    name,
    operationType: "read",
    description,
    requiredScopes: [],
    inputSchema: s.object(`Lookup of one ${label}.`, { key, select: s.optional(selectSchema) }),
    outputSchema: s.object("The requested record.", {
      entity: s.unknownObject("The record properties as returned by the Service Layer."),
    }),
  });
}

export const sapBusinessOneActions: ActionDefinition[] = [
  listAction(
    "list_business_partners",
    "List business partners (customers, suppliers and leads) with optional filtering, sorting and paging.",
    "business partners",
  ),
  getAction(
    "get_business_partner",
    "Read one business partner by its CardCode, including addresses and contact persons.",
    "business partner",
    s.nonEmptyString("CardCode of the business partner, for example C20000."),
  ),
  listAction("list_items", "List items (item master data) with optional filtering, sorting and paging.", "items"),
  getAction(
    "get_item",
    "Read one item from the item master by its ItemCode.",
    "item",
    s.nonEmptyString("ItemCode of the item, for example A00001."),
  ),
  listAction(
    "list_sales_orders",
    "List sales orders (the Orders entity), for example the open orders of one customer.",
    "sales orders",
  ),
  getAction(
    "get_sales_order",
    "Read one sales order with its document lines by DocEntry.",
    "sales order",
    s.positiveInteger("DocEntry, the internal numeric key of the sales order (not the printed DocNum)."),
  ),
  listAction("list_invoices", "List A/R invoices (the Invoices entity).", "A/R invoices"),
  listAction("list_purchase_orders", "List purchase orders (the PurchaseOrders entity).", "purchase orders"),
  defineProviderAction(service, {
    name: "query_entity_set",
    operationType: "read",
    description:
      "Read any Service Layer entity set with OData query options. Use it for objects without a dedicated list action, such as Quotations, DeliveryNotes, Warehouses, or user tables.",
    requiredScopes: [],
    followUpActions: ["fetch_next_page"],
    inputSchema: s.object("OData query against one entity set.", {
      entitySet: entitySetSchema,
      expand: s.optional(
        s.nonEmptyString("Comma-separated navigation properties to include inline ($expand), where supported."),
      ),
      ...listInputProperties,
    }),
    outputSchema: collectionOutputSchema,
  }),
  defineProviderAction(service, {
    name: "fetch_next_page",
    operationType: "read",
    description: "Continue a paged query by following the nextLink returned by a previous list or query action.",
    requiredScopes: [],
    inputSchema: s.object("Paging continuation.", {
      nextLink: s.nonEmptyString("The nextLink value from the previous page, exactly as returned."),
      pageSize: s.optional(pageSizeSchema),
    }),
    outputSchema: collectionOutputSchema,
  }),
  defineProviderAction(service, {
    name: "create_business_partner",
    operationType: "write",
    description:
      "Create a business partner. When CardCode is omitted the Service Layer assigns the next number of the partner series.",
    requiredScopes: [],
    inputSchema: s.object("New business partner.", {
      CardName: s.nonEmptyString("Name of the business partner."),
      CardCode: s.optional(s.nonEmptyString("Code to assign; omit to use the automatic numbering series.")),
      CardType: s.optional(
        s.withDefault(
          s.stringEnum("Kind of partner: cCustomer, cSupplier, or cLid (lead). Defaults to cCustomer.", [
            "cCustomer",
            "cSupplier",
            "cLid",
          ]),
          "cCustomer",
        ),
      ),
      GroupCode: s.optional(s.integer("Numeric code of the business partner group.")),
      Currency: s.optional(s.nonEmptyString("Currency code of the partner, or ##. for all currencies.")),
      Phone1: s.optional(s.nonEmptyString("Primary telephone number.")),
      EmailAddress: s.optional(s.nonEmptyString("Email address.")),
      FederalTaxID: s.optional(s.nonEmptyString("Tax identification number.")),
      additionalFields: s.optional(
        s.unknownObject("Further properties of the BusinessPartners entity (including U_ user fields) to send as is."),
      ),
    }),
    outputSchema: createOutputSchema,
  }),
  defineProviderAction(service, {
    name: "create_sales_order",
    operationType: "write",
    description:
      "Create a sales order for a customer with one or more item lines. The price list supplies the price when Price is omitted.",
    requiredScopes: [],
    inputSchema: s.object("New sales order.", {
      CardCode: s.nonEmptyString("CardCode of the customer."),
      DocDueDate: s.date("Delivery due date in YYYY-MM-DD format."),
      DocDate: s.optional(s.date("Posting date in YYYY-MM-DD format. Defaults to today on the server.")),
      NumAtCard: s.optional(s.nonEmptyString("The customer's own reference number for the order.")),
      Comments: s.optional(s.nonEmptyString("Free-text remarks stored on the order.")),
      DocumentLines: s.array(
        s.object("One order line.", {
          ItemCode: s.nonEmptyString("ItemCode of the item to order."),
          Quantity: s.number({ exclusiveMinimum: 0, description: "Quantity to order." }),
          Price: s.optional(s.number({ minimum: 0, description: "Unit price; omit to use the price list." })),
          WarehouseCode: s.optional(s.nonEmptyString("Warehouse to ship from; omit for the item default.")),
        }),
        { minItems: 1, description: "Lines of the order." },
      ),
    }),
    outputSchema: createOutputSchema,
  }),
  defineProviderAction(service, {
    name: "update_entity",
    operationType: "write",
    description:
      "Change properties of an existing record with PATCH; only the properties in body are modified. Pass a string key for code-keyed entities (BusinessPartners, Items) and a number for DocEntry-keyed documents.",
    requiredScopes: [],
    inputSchema: s.object("Record update.", {
      entitySet: entitySetSchema,
      key: s.union(
        [
          s.nonEmptyString("Text key such as a CardCode or ItemCode."),
          s.integer("Numeric key such as the DocEntry of a document."),
        ],
        { description: "Key of the record to change." },
      ),
      body: s.unknownObject("Properties to change, using the property names of the entity."),
      etag: s.optional(s.nonEmptyString("ETag of the version being changed, sent as If-Match. Omit to overwrite.")),
    }),
    outputSchema: s.object(
      "Result of the update call.",
      {
        updated: s.boolean("True when the Service Layer accepted the change."),
        status: s.integer("HTTP status returned by the Service Layer, normally 204."),
        entity: s.unknownObject("The updated record, when the Service Layer sends one back."),
      },
      { optional: ["entity"] },
    ),
  }),
];
