import type { ProviderDefinition } from "../../core/types.ts";

import { oracleCloudIdentityActions } from "./actions.ts";

const service = "oracle_cloud_identity";

export const provider: ProviderDefinition = {
  service,
  displayName: "Oracle Cloud Identity",
  description:
    "Look up and manage users, groups, and applications in an Oracle Cloud Identity (IDCS / OCI IAM identity domain) through its SCIM 2.0 API, authenticated with an OAuth client credentials app.",
  categories: ["Security", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "serviceInstance",
          label: "Service Instance or Domain URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "idcs-1234567890abcdef1234567890abcdef",
          description:
            "Either the IDCS instance id (idcs- followed by 32 hex characters) or the identity domain URL ending in .identity.oraclecloud.com. The https:// prefix and any path are optional and ignored.",
        },
        {
          key: "clientId",
          label: "Client ID",
          inputType: "text",
          required: true,
          secret: false,
          description:
            "Client ID of a confidential application in the domain that allows the client credentials grant.",
        },
        {
          key: "clientSecret",
          label: "Client Secret",
          inputType: "password",
          required: true,
          secret: true,
          description: "Client secret of the same confidential application.",
        },
        {
          key: "scope",
          label: "Scope",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "urn:opc:idm:__myscopes__",
          description:
            "OAuth scope to request. Leave empty for urn:opc:idm:__myscopes__, which grants whatever app roles (for example User Administrator) the application has been assigned.",
        },
      ],
      testAction: {
        actionName: "list_users",
        input: { count: 1, attributes: "id" },
      },
    },
  ],
  homepageUrl: "https://www.oracle.com/security/cloud-security/cloud-identity/",
  actions: oracleCloudIdentityActions,
};
