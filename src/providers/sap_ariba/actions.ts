import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "sap_ariba";

const approvalNote =
  "The connected Developer Portal application must be approved for this API; otherwise SAP Ariba answers 401 or 403.";

const realmSchema = s.nonEmptyString(
  "Ariba realm (site) to query. Defaults to the realm saved on the connection; required here when the connection has none.",
);

const approvableTypeSchema = s.stringEnum("Kind of approvable document.", ["requisitions", "invoices", "userprofiles"]);

const pageOutputProperties = {
  records: s.array(s.unknownObject("One record exactly as SAP Ariba returned it."), {
    description: "Records in this page.",
  }),
  pageToken: s.nonEmptyString("Continuation token. Pass it back as pageToken to read the next page; absent when done."),
  totalCount: s.integer("Total number of matching records, when the response reports it."),
};

export const actions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_view_templates",
    operationType: "read",
    description:
      "Operational Reporting for Procurement (View Management API): list the reporting view templates defined in a realm, optionally narrowed by document type or status. Use it to find the viewTemplateName that run_report_view needs. " +
      approvalNote,
    requiredScopes: [],
    followUpActions: ["run_report_view"],
    inputSchema: s.object("Filters for listing view templates.", {
      realm: s.optional(realmSchema),
      documentType: s.optional(
        s.nonEmptyString("Only templates for this document type, such as Requisition or PurchaseOrder."),
      ),
      status: s.optional(s.nonEmptyString("Only templates in this status, for example Active.")),
    }),
    outputSchema: s.object("Available view templates.", {
      templates: s.array(s.unknownObject("One view template as returned by SAP Ariba."), {
        description: "View templates visible in the realm.",
      }),
    }),
  }),
  defineProviderAction(service, {
    name: "run_report_view",
    operationType: "read",
    description:
      "Operational Reporting for Procurement (Synchronous API): run a view template and read one page of its records. Filters override the template's defaults and at least one date range of 31 days or less is expected. Pages are small, so follow pageToken until it is absent. " +
      approvalNote,
    requiredScopes: [],
    followUpActions: ["run_report_view"],
    inputSchema: s.object("View to run and how to filter and page it.", {
      viewTemplateName: s.nonEmptyString("Name of the view template, from list_view_templates."),
      realm: s.optional(realmSchema),
      filters: s.optional(
        s.unknownObject(
          'Filter overrides as a JSON object, for example {"updatedDateFrom":"2025-01-01T00:00:00Z","updatedDateTo":"2025-01-15T00:00:00Z"}.',
        ),
      ),
      pageToken: s.optional(s.nonEmptyString("pageToken from the previous page to continue reading.")),
    }),
    outputSchema: s.object("One page of report records.", pageOutputProperties, {
      optional: ["pageToken", "totalCount"],
    }),
  }),
  defineProviderAction(service, {
    name: "list_pending_approvables",
    operationType: "read",
    description:
      "Document Approval API: list documents (requisitions, invoices, user profiles) waiting for approval, either everything pending, everything of one type, or everything pending for one user. Filtering by both type and user at once is not supported by SAP Ariba. " +
      approvalNote,
    requiredScopes: [],
    followUpActions: ["get_approvable", "decide_approvable"],
    inputSchema: s.object("Which pending approvables to list.", {
      realm: s.optional(realmSchema),
      approvableType: s.optional(approvableTypeSchema),
      user: s.optional(s.nonEmptyString("Unique name of the approver; lists only what is pending for that user.")),
      top: s.optional(s.integer({ minimum: 1, maximum: 100, description: "Page size. SAP Ariba defaults to 10." })),
      skip: s.optional(s.nonNegativeInteger("Number of records to skip, for offset paging.")),
    }),
    outputSchema: s.object(
      "Pending approvables.",
      {
        records: pageOutputProperties.records,
        totalCount: pageOutputProperties.totalCount,
      },
      { optional: ["totalCount"] },
    ),
  }),
  defineProviderAction(service, {
    name: "get_approvable",
    operationType: "read",
    description:
      "Document Approval API: read the full details of one requisition, invoice or user profile approvable by its id (the id comes from list_pending_approvables). " +
      approvalNote,
    requiredScopes: [],
    inputSchema: s.object("Approvable to read.", {
      realm: s.optional(realmSchema),
      approvableType: approvableTypeSchema,
      approvableId: s.nonEmptyString("Approvable id as returned by list_pending_approvables."),
    }),
    outputSchema: s.object("The approvable.", {
      approvable: s.unknownObject("The approvable document as returned by SAP Ariba."),
    }),
  }),
  defineProviderAction(service, {
    name: "decide_approvable",
    operationType: "write",
    description:
      "Document Approval API: approve or deny a pending approvable on behalf of a named approver, optionally leaving a comment. This changes the document's approval state in SAP Ariba. " +
      approvalNote,
    requiredScopes: [],
    inputSchema: s.object("Decision to record.", {
      realm: s.optional(realmSchema),
      approvableType: approvableTypeSchema,
      approvableId: s.nonEmptyString("Approvable id as returned by list_pending_approvables."),
      user: s.nonEmptyString("Unique name of the approver the decision is recorded for."),
      passwordAdapter: s.optional(
        s.nonEmptyString("Password adapter of that user, when the realm uses more than one login source."),
      ),
      decision: s.stringEnum("Whether to approve or deny the document.", ["approve", "deny"]),
      comment: s.optional(s.nonEmptyString("Comment to attach to the decision.")),
      commentVisibleToSupplier: s.optional(s.boolean("Let the supplier read the comment. Defaults to false.")),
    }),
    outputSchema: s.object(
      "Result of the decision.",
      {
        submitted: s.boolean("True once SAP Ariba accepted the request."),
        response: s.unknownObject("Response body from SAP Ariba, when it returned one."),
      },
      { optional: ["response"] },
    ),
  }),
  defineProviderAction(service, {
    name: "query_suppliers",
    operationType: "read",
    description:
      "Supplier Data API with Pagination: read supplier master data (name, vendor ids, registration, qualification and preferred status) for a realm, optionally filtered by status, region, category or specific vendor ids. Results come one page at a time; pass the returned pageToken back to continue. " +
      approvalNote,
    requiredScopes: [],
    followUpActions: ["query_suppliers"],
    inputSchema: s.object("Supplier filters and paging.", {
      realm: s.optional(realmSchema),
      smVendorIds: s.optional(s.stringArray("Only these Supplier Management vendor ids, such as S1004848.")),
      registrationStatuses: s.optional(
        s.stringArray("Only suppliers in these registration statuses, such as Registered or Invited."),
      ),
      qualificationStatuses: s.optional(
        s.stringArray("Only suppliers in these qualification statuses, such as Qualified or InQualification."),
      ),
      preferredLevels: s.optional(
        s.array(s.integer({ minimum: 1, maximum: 5 }), { description: "Preferred levels, 1 (highest) to 5." }),
      ),
      regions: s.optional(s.stringArray("Only suppliers in these region codes.")),
      categories: s.optional(s.stringArray("Only suppliers in these category ids.")),
      businessUnits: s.optional(s.stringArray("Only suppliers in these business unit ids.")),
      withQuestionnaire: s.optional(s.boolean("Also include the titles, ids and types of linked questionnaires.")),
      pageLimit: s.optional(
        s.integer({
          minimum: 1,
          maximum: 500,
          description: "Records per page when withQuestionnaire is true. Larger pages risk timeouts.",
        }),
      ),
      pageToken: s.optional(s.nonEmptyString("pageToken from the previous page to continue reading.")),
    }),
    outputSchema: s.object("One page of suppliers.", pageOutputProperties, {
      optional: ["pageToken", "totalCount"],
    }),
  }),
  defineProviderAction(service, {
    name: "query_resource",
    operationType: "read",
    description:
      "Read-only GET against any SAP Ariba Open API path under /api/, for products without a dedicated action (for example sourcing or contract APIs). The realm is added automatically when the connection has one and the query does not set it. The connected application must be approved for whichever API the path belongs to.",
    requiredScopes: [],
    inputSchema: s.object("Raw GET request.", {
      path: s.nonEmptyString(
        "Path starting with /api/, including the API name, version and environment, such as /api/approval/v2/prod/pendingApprovables.",
      ),
      query: s.optional(s.unknownObject("Query parameters as a flat object of strings, numbers or booleans.")),
    }),
    outputSchema: s.object("Response body.", {
      data: s.unknown("Parsed JSON response, or null when SAP Ariba returned an empty body."),
    }),
  }),
];
