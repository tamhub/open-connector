import type { CredentialDefinition } from "../../core/types.ts";

/** Credential field shared by both SAP S/4HANA Cloud providers. */
export const sapApiServerField: CredentialDefinition = {
  key: "apiServer",
  label: "API Server",
  inputType: "text",
  required: true,
  secret: false,
  placeholder: "my123456-api.s4hana.cloud.sap",
  description:
    "Host name of the API endpoint of your system, for example my123456-api.s4hana.cloud.sap or eu10.cfapps.eu10.hana.ondemand.com. A port may be included. The https:// prefix is optional.",
};
