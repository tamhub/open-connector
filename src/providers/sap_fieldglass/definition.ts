import type { ProviderDefinition } from "../../core/types.ts";

import { sapFieldglassActions } from "./actions.ts";

const service = "sap_fieldglass";

export const provider: ProviderDefinition = {
  service,
  displayName: "SAP Fieldglass",
  description:
    "Review and decide pending approvals, run download connectors and read other REST resources in SAP Fieldglass, the vendor management system for contingent workforce and services procurement.",
  categories: ["HR", "Procurement"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "domain",
          label: "Environment Host",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "acme-fgvms.com",
          description:
            "Host name of your Fieldglass environment, without a path. The https:// prefix is optional. Use the host that serves the API; it must be a Fieldglass host on fgvms.com, fieldglass.net or fieldglass.eu, such as <tenant>-fgvms.com, auth.fieldglass.net or sso.fieldglass.eu.",
        },
        {
          key: "clientId",
          label: "Client ID",
          inputType: "text",
          required: true,
          secret: false,
          description: "A valid Fieldglass user name that is allowed to use the REST APIs.",
        },
        {
          key: "clientSecret",
          label: "Client Secret",
          inputType: "password",
          required: true,
          secret: true,
          description:
            "The password of that user, or preferably a license key generated for it in Fieldglass so that password rotation does not break the connection.",
        },
        {
          key: "appKey",
          label: "Application Key (optional)",
          inputType: "password",
          required: false,
          secret: true,
          description:
            "The API application key sent with every request in the X-ApplicationKey header. A Fieldglass Configuration Manager can create or look it up in the Fieldglass application settings (Create API Application Key). Leave it empty if your tenant does not issue one; some APIs work without it, while the approvals API and the token endpoint may reject calls that omit it.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.fieldglass.com/",
  actions: sapFieldglassActions,
};
