import type { ProviderDefinition } from "../../core/types.ts";

import { actions } from "./actions.ts";

const service = "sap_concur";

export const provider: ProviderDefinition = {
  service,
  displayName: "SAP Concur",
  description:
    "Read users, expense reports and expense entries company-wide through the SAP Concur APIs, using an app from Concur App Management and a company-level refresh token.",
  categories: ["Finance", "HR"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "datacenter",
          label: "Data center",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "us2",
          description:
            "Concur data center the company lives in: us, us2, eu2, emea, apj1, usg, glz or cn (or the full host such as us2.api.concursolutions.com). It is the base URI your company's token geolocation points at; the sandbox codes us-impl and emea-impl also work.",
        },
        {
          key: "clientId",
          label: "Client ID",
          inputType: "text",
          required: true,
          secret: false,
          description: "Client ID (UUID) of the app registered in SAP Concur App Management.",
        },
        {
          key: "clientSecret",
          label: "Client Secret",
          inputType: "password",
          required: true,
          secret: true,
          description: "Client secret of the same app.",
        },
        {
          key: "refreshToken",
          label: "Company refresh token",
          inputType: "password",
          required: true,
          secret: true,
          description:
            "Long-lived company-level refresh token. Get it once: in Concur, generate a Company Request Token for your company with the Company Request Token tool, then call POST https://{datacenter host}/oauth2/v0/token with a form body of grant_type=password, client_id, client_secret, username set to the company UUID, password set to the request token and credtype=authtoken. Paste the refresh_token from that response here. The request token works only once, and a refresh token stays valid for roughly six months, after which a new company refresh token must be issued and saved here.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.concur.com",
  actions,
};
