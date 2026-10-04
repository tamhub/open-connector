import type { ProviderDefinition } from "../../core/types.ts";

import { actions } from "./actions.ts";

const service = "sap_ariba";

export const provider: ProviderDefinition = {
  service,
  displayName: "SAP Ariba",
  description:
    "Read procurement reports, approve documents and query supplier data through the SAP Ariba Open APIs, using an application registered in the SAP Ariba Developer Portal.",
  categories: ["Finance", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "subdomain",
          label: "Data center",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "api",
          description:
            "API host prefix of your SAP Ariba data center. One of: api (US), api-eu (Europe), api.au.cloud (Australia), api.jp.cloud (Japan), api.mn1 (UAE), api.mn2 (Saudi Arabia). It is the OAuth server URL prefix shown on the Developer Portal discovery page, without .ariba.com.",
        },
        {
          key: "clientId",
          label: "OAuth Client ID",
          inputType: "text",
          required: true,
          secret: false,
          description: "OAuth client ID of your application in the SAP Ariba Developer Portal.",
        },
        {
          key: "clientSecret",
          label: "OAuth Client Secret",
          inputType: "password",
          required: true,
          secret: true,
          description: "OAuth client secret of the same application.",
        },
        {
          key: "apiKey",
          label: "Application Key",
          inputType: "password",
          required: true,
          secret: true,
          description: "Application key of the application, shown in Manage Applications. Sent as the apiKey header.",
        },
        {
          key: "realm",
          label: "Realm",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "MyCompany-T",
          description:
            "Ariba realm (site name) used by procurement, sourcing and supplier APIs. Leave empty if you only use Ariba Network APIs; actions can also take a realm per call.",
        },
        {
          key: "anid",
          label: "Ariba Network ID",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "AN01234567890",
          description:
            "Optional Ariba Network ID (AN followed by digits), sent as X-ARIBA-NETWORK-ID for Ariba Network APIs.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.sap.com/products/spend-management/ariba.html",
  actions,
};
