import type { ProviderDefinition } from "../../core/types.ts";

import { sapBusinessOneActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "sap_business_one",
  displayName: "SAP Business One",
  description:
    "Read and change SAP Business One business partners, items, orders, and invoices through the Service Layer (OData REST API) of a self-hosted or partner-hosted company database.",
  categories: ["Finance", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "serviceLayerUrl",
          label: "Service Layer URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://b1.example.com:50000",
          description:
            "Address of your Service Layer, usually https://host:50000 (or the port behind your reverse proxy). The https:// prefix is optional, an explicit port is kept, and a pasted /b1s/... path is removed. Only https is supported and the server must present a certificate signed by a public authority, because self-signed certificates cannot be trusted here. Servers on private or internal addresses are reachable only when the deployment administrator enables OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK.",
        },
        {
          key: "companyDb",
          label: "Company Database",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "SBODEMOUS",
          description: "Name of the company database to log in to, as shown on the SAP Business One login screen.",
        },
        {
          key: "username",
          label: "User Name",
          inputType: "text",
          required: true,
          secret: false,
          description:
            "SAP Business One user that will perform the calls. It needs a licence and authorizations for the objects you want to use.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          description: "Password of that SAP Business One user.",
        },
        {
          key: "apiVersion",
          label: "Service Layer API Version",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "v2",
          description:
            "Either v2 (OData v4, the default, for Service Layer 10.0 FP 2111 and later) or v1 (OData v3, for older installations). Leave empty if unsure.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.sap.com/products/erp/business-one.html",
  actions: sapBusinessOneActions,
};
