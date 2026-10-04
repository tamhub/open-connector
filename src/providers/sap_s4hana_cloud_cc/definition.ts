import type { ProviderDefinition } from "../../core/types.ts";

import { createSapS4HanaActions } from "../sap_s4hana_cloud_basic/actions.ts";
import { sapApiServerField } from "../sap_s4hana_cloud_basic/credential-fields.ts";

const service = "sap_s4hana_cloud_cc";

export const provider: ProviderDefinition = {
  service,
  displayName: "SAP S/4HANA Cloud (Client Credentials)",
  description:
    "Query and change SAP S/4HANA Cloud business data through its OData APIs using an OAuth 2.0 client credentials service key.",
  categories: ["Finance", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        sapApiServerField,
        {
          key: "subdomain",
          label: "Subdomain",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "my-subaccount",
          description:
            "Subdomain of the BTP subaccount that issues the token: the first label of the authentication host in the service key URL (lowercase letters, digits, hyphens).",
        },
        {
          key: "region",
          label: "Region",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "eu10",
          description:
            "BTP region of the subaccount, the part between .authentication. and .hana.ondemand.com in the token URL, for example eu10 or us10.",
        },
        {
          key: "clientId",
          label: "Client ID",
          inputType: "text",
          required: true,
          secret: false,
          description: "The clientid value from the service key or communication arrangement.",
        },
        {
          key: "clientSecret",
          label: "Client Secret",
          inputType: "password",
          required: true,
          secret: true,
          description: "The clientsecret value from the same service key.",
        },
        {
          key: "scopes",
          label: "Scopes",
          inputType: "text",
          required: false,
          secret: false,
          description:
            "Optional comma-separated scopes to request. Leave empty to receive every scope granted to the client.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.sap.com/products/erp/s4hana.html",
  actions: createSapS4HanaActions(service),
};
