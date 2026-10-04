import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "oracle_cloud_identity";

const idPattern = "^[A-Za-z0-9._-]+$";

const listOptionNames = ["filter", "attributes", "count", "startIndex", "sortBy", "sortOrder"];

const listProperties = (filterHint: string): Record<string, JsonSchema> => ({
  filter: s.nonEmptyString(
    `Optional SCIM filter expression, for example ${filterHint}. String values must be double-quoted. Attribute names are case-insensitive.`,
  ),
  attributes: s.nonEmptyString(
    "Optional comma-separated attribute names to return (for example id,userName). Keeps responses small.",
  ),
  count: s.integer("Maximum resources per page. The service caps this at 1000.", { minimum: 1, maximum: 1000 }),
  startIndex: s.integer("1-based index of the first resource to return. Use nextStartIndex from the previous page.", {
    minimum: 1,
  }),
  sortBy: s.nonEmptyString("Optional attribute to sort by, for example userName or displayName."),
  sortOrder: s.stringEnum("Sort direction when sortBy is set.", ["ascending", "descending"]),
});

const listOutput = (what: string): JsonSchema =>
  s.object(
    {
      resources: s.array(
        `${what} Each row carries its id, which the get and write actions take.`,
        s.unknownObject("A SCIM resource as returned by the identity domain."),
      ),
      totalResults: s.nullableInteger("Total number of resources matching the request, across all pages."),
      startIndex: s.nullableInteger("1-based index of the first resource in this page."),
      itemsPerPage: s.nullableInteger("Number of resources in this page."),
      nextStartIndex: s.nullableInteger("startIndex to request the next page, or null when this was the last page."),
    },
    { description: "A page of SCIM resources." },
  );

const resourceId = (what: string): JsonSchema =>
  s.string({ description: `${what} (the id value from the matching list action).`, pattern: idPattern, minLength: 1 });

function listAction<const TName extends string>(
  name: TName,
  description: string,
  filterHint: string,
  rows: string,
  followUp: string[],
) {
  return defineProviderAction(service, {
    name,
    description,
    operationType: "read",
    inputSchema: s.object(listProperties(filterHint), {
      optional: listOptionNames,
      description: "Paging, filtering, and projection options.",
    }),
    outputSchema: listOutput(rows),
    followUpActions: followUp,
  });
}

export const oracleCloudIdentityActions: ActionDefinition[] = [
  listAction(
    "list_users",
    "List users in the identity domain, one page at a time. Filter with SCIM syntax and trim the payload with attributes. For a quick name or email lookup use search_users instead.",
    'userName sw "jane" or active eq true',
    "User rows.",
    [`${service}.get_user`, `${service}.search_users`],
  ),
  defineProviderAction(service, {
    name: "get_user",
    description:
      "Fetch one user by id, including name, emails, active flag and (unless trimmed with attributes) group memberships.",
    operationType: "read",
    inputSchema: s.object(
      {
        userId: resourceId("User id"),
        attributes: s.nonEmptyString("Optional comma-separated attribute names to return."),
      },
      { optional: ["attributes"], description: "Identifies the user and which attributes to return." },
    ),
    outputSchema: s.object({ user: s.unknownObject("The SCIM user resource.") }, { description: "A single user." }),
    followUpActions: [`${service}.get_user_groups`, `${service}.set_user_active`],
  }),
  defineProviderAction(service, {
    name: "search_users",
    description:
      "Find users whose user name, display name or email contains the given text. Builds a safe SCIM filter for you, so the query may contain quotes. Returns the same page shape as list_users.",
    operationType: "read",
    inputSchema: s.object(
      {
        query: s.nonEmptyString(
          "Text to look for in userName, displayName and emails. Case-insensitive contains match.",
        ),
        attributes: s.nonEmptyString("Optional comma-separated attribute names to return."),
        count: s.integer("Maximum users to return. Defaults to 25.", { minimum: 1, maximum: 1000 }),
        startIndex: s.integer("1-based index of the first user to return.", { minimum: 1 }),
      },
      { optional: ["attributes", "count", "startIndex"], description: "Text search over users." },
    ),
    outputSchema: listOutput("Matching user rows."),
    followUpActions: [`${service}.get_user`],
  }),
  listAction(
    "list_groups",
    "List groups in the identity domain, one page at a time. Member lists are omitted unless you ask for them through attributes (for example attributes=id,displayName,members).",
    'displayName co "Admin"',
    "Group rows.",
    [`${service}.get_group`],
  ),
  defineProviderAction(service, {
    name: "get_group",
    description:
      "Fetch one group by id. Set includeMembers to also get its member list (users and nested groups with their ids and display names).",
    operationType: "read",
    inputSchema: s.object(
      {
        groupId: resourceId("Group id"),
        includeMembers: s.boolean("Return the members array as well. Off by default because large groups are slow."),
      },
      { optional: ["includeMembers"], description: "Identifies the group and whether to include members." },
    ),
    outputSchema: s.object({ group: s.unknownObject("The SCIM group resource.") }, { description: "A single group." }),
    followUpActions: [`${service}.add_user_to_group`, `${service}.remove_user_from_group`],
  }),
  listAction(
    "list_apps",
    "List applications registered in the identity domain (confidential apps, SAML apps, and so on) with their ids and names.",
    'displayName co "portal"',
    "Application rows.",
    [],
  ),
  defineProviderAction(service, {
    name: "get_user_groups",
    description: "List the groups a user belongs to, as id and display name pairs.",
    operationType: "read",
    inputSchema: s.object(
      { userId: resourceId("User id") },
      { description: "Identifies the user whose memberships to list." },
    ),
    outputSchema: s.object(
      {
        userId: s.string("The user id that was queried."),
        groups: s.array(
          "Groups the user is a member of.",
          s.object(
            {
              id: s.nullableString("Group id."),
              displayName: s.nullableString("Group display name."),
              membershipType: s.nullableString(
                "How the user is a member, for example direct or indirect, when reported.",
              ),
            },
            { description: "One group membership." },
          ),
        ),
      },
      { description: "Group memberships of one user." },
    ),
    followUpActions: [`${service}.get_group`, `${service}.add_user_to_group`],
  }),
  defineProviderAction(service, {
    name: "create_user",
    description:
      "Create a user with a user name, first and last name and a primary work email. The identity domain may send the user an activation email depending on its settings.",
    operationType: "write",
    inputSchema: s.object(
      {
        userName: s.nonEmptyString("Unique sign-in name, usually the email address."),
        givenName: s.nonEmptyString("First name."),
        familyName: s.nonEmptyString("Last name."),
        email: s.email("Primary work email address."),
        displayName: s.nonEmptyString("Optional display name. Defaults to givenName and familyName."),
        active: s.boolean("Whether the user is active. Defaults to true."),
      },
      { optional: ["displayName", "active"], description: "Attributes of the new user." },
    ),
    outputSchema: s.object(
      { user: s.unknownObject("The created SCIM user, including its new id.") },
      { description: "The created user." },
    ),
    followUpActions: [`${service}.add_user_to_group`],
  }),
  defineProviderAction(service, {
    name: "set_user_active",
    description: "Activate or deactivate a user by patching their active flag. A deactivated user cannot sign in.",
    operationType: "write",
    inputSchema: s.object(
      { userId: resourceId("User id"), active: s.boolean("True to activate the user, false to deactivate.") },
      { description: "The user and the desired active state." },
    ),
    outputSchema: s.object(
      {
        userId: s.string("The user id that was updated."),
        active: s.boolean("The active state that was requested."),
        user: s.nullable(s.unknownObject("The updated user as returned by the service, when it returned one.")),
      },
      { description: "Result of the update." },
    ),
    followUpActions: [`${service}.get_user`],
  }),
  defineProviderAction(service, {
    name: "add_user_to_group",
    description: "Add a user to a group by patching the group's members.",
    operationType: "write",
    inputSchema: s.object(
      { groupId: resourceId("Group id"), userId: resourceId("User id") },
      { description: "The group and the user to add." },
    ),
    outputSchema: s.object(
      { groupId: s.string("The group that was changed."), userId: s.string("The user that was added.") },
      { description: "Confirmation of the membership change." },
    ),
    followUpActions: [`${service}.get_user_groups`],
  }),
  defineProviderAction(service, {
    name: "remove_user_from_group",
    description: "Remove a user from a group by patching the group's members.",
    operationType: "write",
    inputSchema: s.object(
      { groupId: resourceId("Group id"), userId: resourceId("User id") },
      { description: "The group and the user to remove." },
    ),
    outputSchema: s.object(
      { groupId: s.string("The group that was changed."), userId: s.string("The user that was removed.") },
      { description: "Confirmation of the membership change." },
    ),
    followUpActions: [`${service}.get_user_groups`],
  }),
  defineProviderAction(service, {
    name: "delete_user",
    description:
      "Permanently delete a user from the identity domain. This cannot be undone; prefer set_user_active to deactivate.",
    operationType: "destructive",
    inputSchema: s.object({ userId: resourceId("User id") }, { description: "The user to delete." }),
    outputSchema: s.object(
      { userId: s.string("The user id that was deleted.") },
      { description: "Confirmation of the deletion." },
    ),
    followUpActions: [],
  }),
];
