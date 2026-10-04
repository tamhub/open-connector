import type { ProviderDefinition } from "../../core/types.ts";

import { successFactorsActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "sap_successfactors",
  displayName: "SAP SuccessFactors",
  description:
    "Read SAP SuccessFactors HR data (users, employees, job information, departments, locations, positions and any other OData entity) through the OData v2 API, using OAuth 2.0 SAML bearer or Basic authentication.",
  categories: ["HR", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      label: "SAML bearer or Basic",
      description:
        "Fill in either the OAuth 2.0 SAML bearer fields (Client ID, User ID, Private Key) or the Basic fields (Username, Password). If a private key is present the SAML bearer flow is used; otherwise Basic.",
      fields: [
        {
          key: "apiServer",
          label: "API Server",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "api4.successfactors.com",
          description:
            "API server host of your data centre, for example api4.successfactors.com or api55preview.sapsf.eu. The https:// prefix is optional. Find it in SAP's list of SuccessFactors API servers.",
        },
        {
          key: "companyId",
          label: "Company ID",
          inputType: "text",
          required: true,
          secret: false,
          description: "Your SuccessFactors company (instance) ID, shown on the login page and in Admin Center.",
        },
        {
          key: "clientId",
          label: "Client ID (SAML bearer)",
          inputType: "text",
          required: false,
          secret: false,
          description:
            "The API Key of the OAuth client registered under Manage OAuth2 Client Applications in Admin Center. Required with a private key.",
        },
        {
          key: "userId",
          label: "User ID (SAML bearer)",
          inputType: "text",
          required: false,
          secret: false,
          description: "The SuccessFactors user the API calls act as. Required with a private key.",
        },
        {
          key: "privateKey",
          label: "Private Key (SAML bearer)",
          inputType: "textarea",
          required: false,
          secret: true,
          placeholder: "-----BEGIN PRIVATE KEY-----",
          description:
            "The RSA private key that matches the X.509 certificate registered for the OAuth client. Paste the PEM, or just the base64 body shown when the key pair was generated.",
        },
        {
          key: "username",
          label: "Username (Basic)",
          inputType: "text",
          required: false,
          secret: false,
          description:
            "API user name for Basic authentication. The company ID is appended automatically as username@companyId.",
        },
        {
          key: "password",
          label: "Password (Basic)",
          inputType: "password",
          required: false,
          secret: true,
          description: "Password of that API user. Used only when no private key is given.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.sap.com/products/hcm/hr-software.html",
  actions: successFactorsActions,
};
