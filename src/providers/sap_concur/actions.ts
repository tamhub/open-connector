import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "sap_concur";

const scopeNote =
  "The Concur app must be granted the matching scope in App Management; otherwise Concur answers 401 or 403.";

const dateNote = "Format yyyy-MM-dd or yyyy-MM-ddTHH:mm:ss.";

const reportListOutput = s.object(
  "One page of expense reports.",
  {
    reports: s.array(s.unknownObject("One expense report summary as returned by Concur."), {
      description: "Reports in this page.",
    }),
    nextOffset: s.nonEmptyString("Pass back as offset to read the next page; absent on the last page."),
  },
  { optional: ["nextOffset"] },
);

export const actions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_users",
    operationType: "read",
    description:
      "Identity API v4 (SCIM): list user profiles in the company. Filter by userName, employeeNumber or externalId, and page with startIndex and count. Each user carries the id (UUID) that other Concur v4 APIs need. " +
      scopeNote,
    requiredScopes: [],
    followUpActions: ["get_user"],
    inputSchema: s.object("Filter and paging for the user list.", {
      filter: s.optional(
        s.nonEmptyString(
          'SCIM filter expression, for example userName eq "jane@example.com" or employeeNumber eq "1042".',
        ),
      ),
      count: s.optional(s.integer({ minimum: 1, maximum: 100, description: "Users per page, at most 100." })),
      startIndex: s.optional(s.positiveInteger("1-based index of the first user to return, for paging.")),
    }),
    outputSchema: s.object(
      "One page of users.",
      {
        users: s.array(s.unknownObject("One SCIM user as returned by Concur."), { description: "Users in this page." }),
        totalResults: s.integer("Total number of matching users."),
        itemsPerPage: s.integer("Number of users in this page."),
        startIndex: s.integer("1-based index of the first user in this page."),
      },
      { optional: ["totalResults", "itemsPerPage", "startIndex"] },
    ),
  }),
  defineProviderAction(service, {
    name: "get_user",
    operationType: "read",
    description: "Identity API v4: read one user profile by its Concur UUID (the id from list_users). " + scopeNote,
    requiredScopes: [],
    inputSchema: s.object("User to read.", {
      userId: s.nonEmptyString("Concur user id (UUID) as returned by list_users."),
    }),
    outputSchema: s.object("The user.", { user: s.unknownObject("The SCIM user as returned by Concur.") }),
  }),
  defineProviderAction(service, {
    name: "list_expense_reports",
    operationType: "read",
    description:
      "Expense API v3: list expense reports across the whole company (user defaults to ALL, which needs a company-level token with the Web Services Admin role). Narrow by approval or payment status and by modified, created or submitted dates. Follow nextOffset to read further pages. " +
      scopeNote,
    requiredScopes: [],
    followUpActions: ["get_expense_report", "list_expense_entries", "list_expense_reports"],
    inputSchema: s.object("Filters and paging for the report list.", {
      user: s.optional(
        s.nonEmptyString("Login id of one report owner. Defaults to ALL, meaning every user in the company."),
      ),
      approvalStatusCode: s.optional(
        s.nonEmptyString(
          "Approval status code, or several separated by commas. Common values: A_PEND (pending approval), A_APPR (approved), A_RESU (sent back), A_NOTF (not submitted).",
        ),
      ),
      paymentStatusCode: s.optional(
        s.nonEmptyString("Payment status code, or several separated by commas, for example P_NOTP or P_PAID."),
      ),
      modifiedDateAfter: s.optional(s.nonEmptyString("Only reports modified after this date. " + dateNote)),
      modifiedDateBefore: s.optional(s.nonEmptyString("Only reports modified before this date. " + dateNote)),
      createDateAfter: s.optional(s.nonEmptyString("Only reports created after this date. " + dateNote)),
      createDateBefore: s.optional(s.nonEmptyString("Only reports created before this date. " + dateNote)),
      submitDateAfter: s.optional(s.nonEmptyString("Only reports submitted after this date. " + dateNote)),
      submitDateBefore: s.optional(s.nonEmptyString("Only reports submitted before this date. " + dateNote)),
      limit: s.optional(
        s.integer({ minimum: 1, maximum: 100, description: "Reports per page. Concur defaults to 25." }),
      ),
      offset: s.optional(s.nonEmptyString("nextOffset from the previous page to continue reading.")),
    }),
    outputSchema: reportListOutput,
  }),
  defineProviderAction(service, {
    name: "get_expense_report",
    operationType: "read",
    description:
      "Expense API v3: read one expense report with its header details (status, totals, owner, dates, custom fields). Concur requires the login id of the report owner; the ALL shortcut is not accepted for a single report. " +
      scopeNote,
    requiredScopes: [],
    followUpActions: ["list_expense_entries"],
    inputSchema: s.object("Report to read.", {
      reportId: s.nonEmptyString("Report id as returned by list_expense_reports."),
      user: s.nonEmptyString("Login id of the report owner, as OwnerLoginID on the list result."),
    }),
    outputSchema: s.object("The report.", { report: s.unknownObject("The report as returned by Concur.") }),
  }),
  defineProviderAction(service, {
    name: "list_expense_entries",
    operationType: "read",
    description:
      "Expense API v3: list the expense entries (line items) of one report. Pass the owner's login id when you have it; otherwise user defaults to ALL. Follow nextOffset for more pages. " +
      scopeNote,
    requiredScopes: [],
    inputSchema: s.object("Report whose entries to list.", {
      reportId: s.nonEmptyString("Report id as returned by list_expense_reports."),
      user: s.optional(s.nonEmptyString("Login id of the report owner. Defaults to ALL.")),
      limit: s.optional(
        s.integer({ minimum: 1, maximum: 100, description: "Entries per page. Concur defaults to 25." }),
      ),
      offset: s.optional(s.nonEmptyString("nextOffset from the previous page to continue reading.")),
    }),
    outputSchema: s.object(
      "One page of entries.",
      {
        entries: s.array(s.unknownObject("One expense entry as returned by Concur."), {
          description: "Entries in this page.",
        }),
        nextOffset: s.nonEmptyString("Pass back as offset to read the next page; absent on the last page."),
      },
      { optional: ["nextOffset"] },
    ),
  }),
  defineProviderAction(service, {
    name: "query_resource",
    operationType: "read",
    description:
      "Read-only GET against any SAP Concur API path on the company's data center, for APIs without a dedicated action (for example /api/v3.0/expense/expensegroupconfigurations or /travelrequest/v4/requests). Concur returns JSON when asked, which this action does. The Concur app needs the scope of whichever API the path belongs to.",
    requiredScopes: [],
    inputSchema: s.object("Raw GET request.", {
      path: s.nonEmptyString("Path starting with /, such as /api/v3.0/common/users, without a query string."),
      query: s.optional(s.unknownObject("Query parameters as a flat object of strings, numbers or booleans.")),
    }),
    outputSchema: s.object("Response body.", {
      data: s.unknown("Parsed JSON response, or null when Concur returned an empty body."),
    }),
  }),
];
