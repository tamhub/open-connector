import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "sap_fieldglass";

const moduleIdSchema = s.stringPattern("^[0-9]{1,6}$", {
  description:
    "Numeric Fieldglass module id of the kind of work item, for example 40 (job posting), 70 (timesheet), 180 (invoice), 270 (work order), 430 (expense sheet), 540 (SOW).",
});
const workItemIdSchema = s.stringPattern("^[A-Za-z0-9_-]{1,64}$", {
  description: "Database-level id of the work item, taken from the id field returned by list_pending_approvals.",
});
const forUserSchema = s.nonEmptyString(
  "Fieldglass user name to act on behalf of. Only set it when the API user is allowed to impersonate that person.",
);
const commentsSchema = s.nonEmptyString("Free-text comment recorded with the decision.");

const approvalItemSchema = s.object(
  "One work item with its core attributes.",
  {
    moduleId: s.string("Numeric module id of the work item."),
    moduleName: s.string("Module name, which is also the kind of object, for example Job Posting."),
    id: s.string("Database-level id used for the detail, approve and reject calls."),
    reference: s.string("Human-visible object number, for example a job posting or work order number."),
    name: s.string("Name of the object as entered by users."),
    amount: s.string("Amount awaiting approval, formatted as text by Fieldglass."),
    currency: s.string("Three-letter currency code of the amount."),
    startDate: s.string("Start date of the object (format depends on the tenant)."),
    status: s.string("Workflow status text, normally Pending Approval."),
    attributes: s.unknownObject(
      "Every attribute Fieldglass returned for the item, including the module-specific others section on detail reads.",
    ),
  },
  { optional: ["moduleId", "moduleName", "reference", "name", "amount", "currency", "startDate", "status"] },
);

export const sapFieldglassActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_pending_approvals",
    operationType: "read",
    description:
      "List the work items waiting for the API user's approval, optionally limited to one module such as timesheets or work orders. Use the returned id and moduleId to inspect, approve or reject an item.",
    requiredScopes: [],
    followUpActions: ["get_approval_item", "approve_item", "reject_item"],
    inputSchema: s.object("Optional module filter and impersonation.", {
      moduleId: s.optional(moduleIdSchema),
      forUser: s.optional(forUserSchema),
    }),
    outputSchema: s.object("Pending work items.", {
      count: s.integer("Number of items returned."),
      items: s.array(approvalItemSchema, { description: "Work items awaiting a decision." }),
    }),
  }),
  defineProviderAction(service, {
    name: "get_approval_item",
    operationType: "read",
    description:
      "Read the full detail of one work item that needs approval, including the module-specific fields a reviewer needs before deciding.",
    requiredScopes: [],
    followUpActions: ["approve_item", "list_rejection_reasons"],
    inputSchema: s.object("Which work item to read.", {
      moduleId: moduleIdSchema,
      workItemId: workItemIdSchema,
    }),
    outputSchema: s.object("The work item detail.", { item: approvalItemSchema }),
  }),
  defineProviderAction(service, {
    name: "list_rejection_reasons",
    operationType: "read",
    description:
      "List the rejection reasons configured for a module. Rejecting requires one of these reason ids, and ids are specific to the module.",
    requiredScopes: [],
    followUpActions: ["reject_item"],
    inputSchema: s.object("Module to list reasons for.", { moduleId: moduleIdSchema }),
    outputSchema: s.object("Rejection reasons.", {
      reasons: s.array(
        s.object("One rejection reason.", {
          id: s.string("Reason id to pass to reject_item."),
          description: s.string("Reason text shown to users."),
        }),
        { description: "Reasons configured for the module." },
      ),
    }),
  }),
  defineProviderAction(service, {
    name: "approve_item",
    operationType: "write",
    description:
      "Approve one pending work item. This advances the workflow in Fieldglass and cannot be undone through the API, so confirm the decision with the user first.",
    requiredScopes: [],
    inputSchema: s.object("Item to approve.", {
      moduleId: moduleIdSchema,
      workItemId: workItemIdSchema,
      comments: s.optional(commentsSchema),
      forUser: s.optional(forUserSchema),
    }),
    outputSchema: s.object(
      "Result of the approval call.",
      {
        approved: s.boolean("True when Fieldglass accepted the decision."),
        response: s.unknownObject("Raw response body from Fieldglass, when it returned one."),
      },
      { optional: ["response"] },
    ),
  }),
  defineProviderAction(service, {
    name: "reject_item",
    operationType: "write",
    description:
      "Reject one pending work item using a rejection reason id for its module. Confirm with the user first, since the submitter is notified and the item leaves the approval queue.",
    requiredScopes: [],
    inputSchema: s.object("Item to reject.", {
      moduleId: moduleIdSchema,
      workItemId: workItemIdSchema,
      reasonId: s.stringPattern("^[A-Za-z0-9_-]{1,64}$", {
        description: "Rejection reason id from list_rejection_reasons for the same module.",
      }),
      comments: s.optional(commentsSchema),
      forUser: s.optional(forUserSchema),
    }),
    outputSchema: s.object(
      "Result of the rejection call.",
      {
        rejected: s.boolean("True when Fieldglass accepted the decision."),
        response: s.unknownObject("Raw response body from Fieldglass, when it returned one."),
      },
      { optional: ["response"] },
    ),
  }),
  defineProviderAction(service, {
    name: "run_download_connector",
    operationType: "read",
    description:
      "Run a Fieldglass download connector by name and return its rows as records. Connectors are the integration extracts an administrator enabled, such as worker, timesheet or work order downloads. Handles JSON and CSV responses and caps the number of rows returned.",
    requiredScopes: [],
    inputSchema: s.object("Connector to run.", {
      connectorName: s.stringPattern("^[A-Za-z0-9_.-]{1,100}$", {
        description: "Exact connector name as listed in the Fieldglass connector library for your tenant.",
      }),
      parameters: s.optional(
        s.stringArray("Positional connector parameters, sent as __p1, __p2 and so on in order.", { maxItems: 20 }),
      ),
      maxRecords: s.optional(
        s.withDefault(
          s.integer({ minimum: 1, maximum: 5000, description: "Maximum number of rows to return. Defaults to 500." }),
          500,
        ),
      ),
    }),
    outputSchema: s.object(
      "Connector rows.",
      {
        format: s.stringEnum("How the response was parsed.", ["json", "csv", "text"]),
        records: s.array(s.unknownObject("One row."), {
          description: "Rows from the connector, as objects keyed by column name.",
        }),
        totalRecords: s.integer("Rows present in the response before the cap was applied."),
        truncated: s.boolean("True when rows were dropped because of maxRecords."),
        text: s.string("Raw response text, set only when the body was neither JSON nor CSV."),
      },
      { optional: ["text"] },
    ),
  }),
  defineProviderAction(service, {
    name: "query_resource",
    operationType: "read",
    description:
      "Read any Fieldglass REST resource with a GET under the /api path, for example resources on your tenant that have no dedicated action. The path is relative to /api. Tenants differ in which resources are enabled, so check the Fieldglass API documentation for your environment.",
    requiredScopes: [],
    inputSchema: s.object("GET request to a Fieldglass API resource.", {
      path: s.nonEmptyString(
        "Resource path relative to /api, such as v1/approvals or vc/connector/my_connector. A leading /api is accepted. Only plain path characters are allowed.",
      ),
      query: s.optional(
        s.record(s.union([s.string(), s.number(), s.boolean()]), {
          description: "Query string parameters as a flat object.",
        }),
      ),
    }),
    outputSchema: s.object(
      "Parsed response.",
      {
        status: s.integer("HTTP status code."),
        data: s.unknown("Parsed JSON body, or the raw text when the body is not JSON."),
      },
      { optional: ["data"] },
    ),
  }),
];
