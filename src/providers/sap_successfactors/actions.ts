import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "sap_successfactors";

const filterSchema = s.nonEmptyString(
  "OData $filter expression, for example status eq 'active' or userId eq 'jsmith'. Dates are written as datetime'2024-01-01T00:00:00'.",
);
const selectSchema = s.nonEmptyString(
  "Comma-separated property names to return ($select). Strongly recommended: these entities have many properties.",
);
const expandSchema = s.nonEmptyString("Comma-separated navigation properties to include inline ($expand).");
const orderbySchema = s.nonEmptyString("OData $orderby expression, for example lastName asc.");
const topSchema = s.withDefault(
  s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of records to return ($top). Defaults to 50." }),
  50,
);
const skipSchema = s.nonNegativeInteger("Number of records to skip ($skip), for offset paging.");
const includeCountSchema = s.boolean("Also request the total number of matching records, returned as totalCount.");

const collectionOutputSchema = s.object(
  "A page of records. Date values come back in the OData form /Date(milliseconds)/.",
  {
    records: s.array(s.unknownObject("One entity record as returned by SuccessFactors."), {
      description: "Entities in this page.",
    }),
    nextLink: s.nonEmptyString(
      "Path and query of the next page when more results exist; pass it to fetch_next_page. Absent on the last page.",
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

const listAction = <const TName extends string>(name: TName, description: string, label: string) =>
  defineProviderAction(service, {
    name,
    operationType: "read",
    description,
    requiredScopes: [],
    followUpActions: ["fetch_next_page"],
    inputSchema: s.object(`Filters and paging for listing ${label}.`, listInputProperties),
    outputSchema: collectionOutputSchema,
  });

export const successFactorsActions: ActionDefinition[] = [
  listAction(
    "list_users",
    "List user accounts in the SuccessFactors tenant (User entity): login ids, names, email, status, manager and department. Good starting point for finding a userId.",
    "users",
  ),
  defineProviderAction(service, {
    name: "get_user",
    operationType: "read",
    description:
      "Read a single user by userId, optionally selecting properties or expanding navigations such as manager.",
    requiredScopes: [],
    inputSchema: s.object("User lookup.", {
      userId: s.nonEmptyString("The SuccessFactors userId, as returned by list_users."),
      select: s.optional(selectSchema),
      expand: s.optional(expandSchema),
    }),
    outputSchema: s.object("The requested user.", { user: s.unknownObject("The user's properties.") }),
  }),
  listAction(
    "list_employees",
    "List people from Employee Central (PerPerson entity). Personal info and employment records are expanded inline by default (personalInfoNav, employmentNav); override expand or select to change that. Filter by personIdExternal for one person.",
    "employees",
  ),
  listAction(
    "list_job_info",
    "List job information records from Employee Central (EmpJob entity): job title, position, department, location, manager and start/end dates. Filter by userId to get one person's job history.",
    "job information records",
  ),
  listAction("list_departments", "List departments from the foundation objects (FODepartment entity).", "departments"),
  listAction("list_locations", "List locations from the foundation objects (FOLocation entity).", "locations"),
  listAction(
    "list_positions",
    "List positions from position management (Position entity), including vacancy and incumbent information when selected.",
    "positions",
  ),
  defineProviderAction(service, {
    name: "query_entity_set",
    operationType: "read",
    description:
      "Read any OData v2 entity set the API user can access, with $filter, $select, $expand, $orderby and paging. Use this when no dedicated list action fits, for example FOJobCode, EmpCompensation or PerPhone.",
    requiredScopes: [],
    followUpActions: ["fetch_next_page"],
    inputSchema: s.object("OData query against one entity set.", {
      entitySet: s.nonEmptyString("Name of the entity set under /odata/v2, such as FOJobCode."),
      ...listInputProperties,
    }),
    outputSchema: collectionOutputSchema,
  }),
  defineProviderAction(service, {
    name: "fetch_next_page",
    operationType: "read",
    description: "Continue a paginated query by following the nextLink returned from a previous list or query action.",
    requiredScopes: [],
    inputSchema: s.object("Server-driven paging continuation.", {
      nextLink: s.nonEmptyString("The nextLink value from the previous page, exactly as returned."),
    }),
    outputSchema: collectionOutputSchema,
  }),
];
