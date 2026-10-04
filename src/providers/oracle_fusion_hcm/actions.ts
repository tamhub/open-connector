import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "oracle_fusion_hcm";

/** REST collection each list action reads, relative to the HCM REST version root. */
export const oracleFusionHcmListResources = {
  list_workers: "workers",
  list_departments: "departmentsLov",
  list_jobs: "jobs",
  list_positions: "positions",
  list_locations: "locationsV2",
  list_grades: "grades",
  list_absences: "absences",
} as const;

export type OracleFusionHcmCollectionKey = keyof typeof oracleFusionHcmListResources;

const queryOptionNames = ["q", "limit", "offset", "fields", "expand", "orderBy", "totalResults", "finder"];

const queryProperties = (qHint: string): Record<string, JsonSchema> => ({
  q: s.nonEmptyString(
    `Optional row filter in Oracle REST syntax: attribute=value terms combined with ";" for AND. Attribute names are case-sensitive. ${qHint}`,
  ),
  limit: s.integer("Maximum rows per page. Oracle caps this at 500 and defaults to 25.", {
    minimum: 1,
    maximum: 500,
  }),
  offset: s.nonNegativeInteger("Zero-based index of the first row to return. Use nextOffset from the previous page."),
  fields: s.nonEmptyString(
    "Optional comma-separated attribute names to return, for example PersonId,PersonNumber. Keeps responses small.",
  ),
  expand: s.nonEmptyString(
    "Optional comma-separated child resources to include inline, for example names,emails or workRelationships.assignments.",
  ),
  orderBy: s.nonEmptyString('Optional sort such as "LastUpdateDate:desc" (attribute:asc|desc, comma-separated).'),
  totalResults: s.boolean("Ask Oracle to also compute the total matching row count. Slower on large tables."),
  finder: s.nonEmptyString(
    "Optional predefined finder with its bind variables, for example findByWords;words=smith. Finder names differ per resource.",
  ),
});

const collectionOutput = (rowDescription: string): JsonSchema =>
  s.object(
    {
      items: s.array(
        `${rowDescription} Each row carries uniqueId (the key detail endpoints need) when Oracle returned a self link.`,
        s.unknownObject("A resource row as returned by Oracle, with link metadata removed."),
      ),
      count: s.integer("Number of rows in this page."),
      hasMore: s.boolean("True when more rows exist beyond this page."),
      limit: s.nullableInteger("Page size Oracle applied."),
      offset: s.nullableInteger("Offset of the first row in this page."),
      nextOffset: s.nullableInteger("Offset to request the next page, or null when there are no more rows."),
      totalResults: s.nullableInteger("Total matching rows, present only when totalResults was requested."),
    },
    { description: "A page of Oracle HCM REST rows." },
  );

function listAction<const TName extends OracleFusionHcmCollectionKey>(
  name: TName,
  description: string,
  qHint: string,
  rowDescription: string,
) {
  return defineProviderAction(service, {
    name,
    description,
    operationType: "read",
    inputSchema: s.object(queryProperties(qHint), {
      optional: queryOptionNames,
      description: "Paging, filtering, and projection options for the collection.",
    }),
    outputSchema: collectionOutput(rowDescription),
    followUpActions: name === "list_workers" ? [`${service}.get_worker`] : [`${service}.query_resource`],
  });
}

export const oracleFusionHcmActions: ActionDefinition[] = [
  listAction(
    "list_workers",
    "List workers (employees and contingent workers) from Oracle HCM, one page at a time. Use fields and expand to control size, for example expand=names,emails or workRelationships.assignments. Each row's uniqueId is the key get_worker needs.",
    "Example: PersonNumber=1234.",
    "Worker rows.",
  ),
  defineProviderAction(service, {
    name: "get_worker",
    description:
      "Fetch one worker by its Oracle resource key. Oracle's worker key is an opaque hash, not the person number: take it from uniqueId in a list_workers row (the last path segment of the row's self link). Use expand to include children such as names, emails, phones, or workRelationships.assignments.",
    operationType: "read",
    inputSchema: s.object(
      {
        workerId: s.nonEmptyString("Opaque worker key: the uniqueId value returned by list_workers."),
        fields: s.nonEmptyString("Optional comma-separated attributes to return."),
        expand: s.nonEmptyString("Optional comma-separated child resources to include inline."),
      },
      { optional: ["fields", "expand"], description: "Identifies the worker and which parts to return." },
    ),
    outputSchema: s.object(
      { worker: s.unknownObject("The worker as returned by Oracle, with link metadata removed.") },
      { description: "A single worker." },
    ),
    followUpActions: [`${service}.list_workers`],
  }),
  listAction(
    "list_departments",
    "List departments from Oracle HCM's departments list of values, with organization ids, names, and statuses.",
    "Example: Name=Sales.",
    "Department rows.",
  ),
  listAction(
    "list_jobs",
    "List job definitions (code, name, family, status) configured in Oracle HCM.",
    "Example: JobCode=ENG1.",
    "Job rows.",
  ),
  listAction(
    "list_positions",
    "List positions (code, name, department, job, headcount) configured in Oracle HCM.",
    "Example: PositionCode=P100.",
    "Position rows.",
  ),
  listAction(
    "list_locations",
    "List work locations (name, address, country, active dates) defined in Oracle HCM.",
    "Example: LocationName=Headquarters.",
    "Location rows.",
  ),
  listAction(
    "list_grades",
    "List grades (code, name, active status) defined in Oracle HCM.",
    "Example: GradeCode=G5.",
    "Grade rows.",
  ),
  listAction(
    "list_absences",
    "List employee absence records (person, absence type, start and end dates, status). Filter with q, for example by person number or date range, to avoid pulling the whole table.",
    "Example: personNumber=1234 or startDate>=2025-01-01 (dates as YYYY-MM-DD).",
    "Absence rows.",
  ),
  defineProviderAction(service, {
    name: "query_resource",
    description:
      "Read any Oracle HCM REST collection or item by path, for resources without a dedicated action (for example publicWorkers, legalEmployers, or a worker child such as workers/<uniqueId>/child/emails). The path is relative to the REST version root /hcmRestApi/resources/11.13.18.05/ and must not contain .. or a host. Always GET.",
    operationType: "read",
    inputSchema: s.object(
      {
        path: s.nonEmptyString(
          "Resource path relative to the version root, such as publicWorkers or workers/<uniqueId>/child/emails. No scheme, host, query string, or ..",
        ),
        ...queryProperties("Applies to collection paths."),
        onlyData: s.boolean("Strip link metadata from the response. Defaults to true."),
      },
      {
        optional: [...queryOptionNames, "onlyData"],
        description: "Path plus the standard Oracle REST query options.",
      },
    ),
    outputSchema: s.object(
      {
        data: s.unknown("Parsed JSON body returned by Oracle. A collection has items, count, and hasMore."),
      },
      { description: "Raw Oracle response." },
    ),
  }),
];
