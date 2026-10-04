import type { ProviderDefinition } from "../../core/types.ts";

import { sapS4HanaBasicActions } from "./actions.ts";
import { sapApiServerField } from "./credential-fields.ts";

export const provider: ProviderDefinition = {
  service: "sap_s4hana_cloud_basic",
  displayName: "SAP S/4HANA Cloud (Basic Auth)",
  description:
    "Query and change SAP S/4HANA Cloud business data through its OData APIs using a communication user with HTTP Basic authentication.",
  categories: ["Finance", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        sapApiServerField,
        {
          key: "username",
          label: "Communication User",
          inputType: "text",
          required: true,
          secret: false,
          description:
            "The user of the communication system that is linked to your communication arrangements, with Basic authentication enabled.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          description: "The password set for that communication user.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.sap.com/products/erp/s4hana.html",
  actions: sapS4HanaBasicActions,
};
