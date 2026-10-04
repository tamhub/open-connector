import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const servicePathSchema = s.nonEmptyString(
  "URL path of the OData service on the API host, such as /sap/opu/odata/sap/API_BUSINESS_PARTNER (OData v2) or /sap/opu/odata4/sap/api_xyz/srvd_a2x/sap/xyz/0001 (OData v4).",
);
const entitySetSchema = s.nonEmptyString("Name of the entity set inside the service, such as A_BusinessPartner.");
const odataVersionSchema = s.withDefault(
  s.stringEnum("OData protocol of the service. Released S/4HANA Cloud APIs are mostly v2; defaults to v2.", [
    "v2",
    "v4",
  ]),
  "v2",
);
const filterSchema = s.nonEmptyString(
  "OData $filter expression, for example BusinessPartnerCategory eq '1' and CreationDate ge datetime'2024-01-01T00:00:00'.",
);
const selectSchema = s.nonEmptyString("Comma-separated property names to return ($select). Omit for all properties.");
const expandSchema = s.nonEmptyString("Comma-separated navigation properties to include inline ($expand).");
const orderbySchema = s.nonEmptyString("OData $orderby expression, for example CreationDate desc.");
const topSchema = s.withDefault(
  s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of records to return ($top). Defaults to 50." }),
  50,
);
const skipSchema = s.nonNegativeInteger("Number of records to skip ($skip), for offset paging.");
const includeCountSchema = s.boolean(
  "Also ask the server for the total number of matching records, returned as totalCount.",
);
const keySchema = s.nonEmptyString(
  "Raw OData key predicate without the surrounding parentheses: a quoted single key like '1000001', or composite keys like SalesOrder='1',Item='10'.",
);
const bodySchema = s.unknownObject(
  "Entity properties to send as the JSON request body. Use the property names of the target entity type.",
);

const collectionOutputSchema = s.object(
  "A page of entity records.",
  {
    records: s.array(s.unknownObject("One entity record as returned by the service."), {
      description: "Entities in this page.",
    }),
    nextLink: s.nonEmptyString(
      "Path and query of the next page when the server paginates; pass it to fetch_next_page. Absent on the last page.",
    ),
    totalCount: s.integer("Total matching records, present only when includeCount was requested."),
  },
  { optional: ["nextLink", "totalCount"] },
);

const listInputProperties: Record<string, JsonSchema> = {
  filter: s.optional(filterSchema),
  select: s.optional(selectSchema),
  expand: s.optional(expandSchema),
  orderby: s.optional(orderbySchema),
  top: s.optional(topSchema),
  skip: s.optional(skipSchema),
  includeCount: s.optional(includeCountSchema),
};

/**
 * Build the SAP S/4HANA Cloud OData action set. Both SAP providers expose the
 * same actions; only the service id differs.
 */
export function createSapS4HanaActions(service: string): ActionDefinition[] {
  const listAction = <const TName extends string>(name: TName, description: string, label: string) =>
    defineProviderAction(service, {
      name,
      operationType: "read",
      description,
      requiredScopes: [],
      inputSchema: s.object(`Filters and paging for listing ${label}.`, listInputProperties),
      outputSchema: collectionOutputSchema,
    });

  return [
    defineProviderAction(service, {
      name: "query_entity_set",
      operationType: "read",
      description:
        "Read any entity set from any OData service the communication user can access. Supports $filter, $select, $expand, $orderby, paging and a total count. Use this when no dedicated list action fits.",
      requiredScopes: [],
      followUpActions: ["fetch_next_page", "get_entity"],
      inputSchema: s.object("OData query against one entity set.", {
        servicePath: servicePathSchema,
        entitySet: entitySetSchema,
        odataVersion: s.optional(odataVersionSchema),
        ...listInputProperties,
      }),
      outputSchema: collectionOutputSchema,
    }),
    defineProviderAction(service, {
      name: "get_entity",
      operationType: "read",
      description: "Read a single entity by its key from an OData service.",
      requiredScopes: [],
      inputSchema: s.object("Entity lookup by key.", {
        servicePath: servicePathSchema,
        entitySet: entitySetSchema,
        key: keySchema,
        odataVersion: s.optional(odataVersionSchema),
        select: s.optional(selectSchema),
        expand: s.optional(expandSchema),
      }),
      outputSchema: s.object("The requested entity.", {
        entity: s.unknownObject(
          "The entity properties. For OData v2 the ETag is in __metadata.etag, for v4 in @odata.etag; pass it as etag to update_entity.",
        ),
      }),
    }),
    defineProviderAction(service, {
      name: "fetch_next_page",
      operationType: "read",
      description:
        "Continue a paginated query by following the nextLink returned from a previous query or list action.",
      requiredScopes: [],
      inputSchema: s.object("Server-driven paging continuation.", {
        nextLink: s.nonEmptyString("The nextLink value from the previous page, as returned."),
      }),
      outputSchema: collectionOutputSchema,
    }),
    listAction(
      "list_business_partners",
      "List business partners (customers, suppliers, contacts) from the Business Partner API.",
      "business partners",
    ),
    listAction("list_sales_orders", "List sales orders from the Sales Order API.", "sales orders"),
    listAction("list_purchase_orders", "List purchase orders from the Purchase Order API.", "purchase orders"),
    listAction("list_products", "List products from the Product Master API.", "products"),
    defineProviderAction(service, {
      name: "create_entity",
      operationType: "write",
      description:
        "Create a new entity in an OData service. The CSRF token handshake is performed automatically. Returns the created entity when the service sends it back.",
      requiredScopes: [],
      inputSchema: s.object("Entity to create.", {
        servicePath: servicePathSchema,
        entitySet: entitySetSchema,
        body: bodySchema,
        odataVersion: s.optional(odataVersionSchema),
      }),
      outputSchema: s.object(
        "Result of the create call.",
        {
          status: s.integer("HTTP status returned by the service, normally 201."),
          entity: s.unknownObject("The created entity, when the service returns a representation."),
        },
        { optional: ["entity"] },
      ),
    }),
    defineProviderAction(service, {
      name: "update_entity",
      operationType: "write",
      description:
        "Change properties of an existing entity by key. Only the properties in body are modified (PATCH). The CSRF token handshake is performed automatically.",
      requiredScopes: [],
      inputSchema: s.object("Entity update.", {
        servicePath: servicePathSchema,
        entitySet: entitySetSchema,
        key: keySchema,
        body: bodySchema,
        odataVersion: s.optional(odataVersionSchema),
        etag: s.optional(
          s.nonEmptyString(
            "ETag of the entity version being changed. Defaults to * (overwrite regardless of version).",
          ),
        ),
        method: s.optional(
          s.withDefault(
            s.stringEnum(
              "HTTP method used for the change. PATCH is right for current APIs; MERGE only for legacy services.",
              ["PATCH", "MERGE", "PUT"],
            ),
            "PATCH",
          ),
        ),
      }),
      outputSchema: s.object(
        "Result of the update call.",
        {
          updated: s.boolean("True when the service accepted the change."),
          status: s.integer("HTTP status returned by the service, normally 204 or 200."),
          entity: s.unknownObject("The updated entity, when the service returns a representation."),
        },
        { optional: ["entity"] },
      ),
    }),
  ];
}

export const sapS4HanaBasicActions: ActionDefinition[] = createSapS4HanaActions("sap_s4hana_cloud_basic");
