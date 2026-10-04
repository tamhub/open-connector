import type { ProviderDefinition } from "../../core/types.ts";

import { oracleFusionHcmActions } from "./actions.ts";

const service = "oracle_fusion_hcm";

export const provider: ProviderDefinition = {
  service,
  displayName: "Oracle Fusion Cloud HCM",
  description:
    "Read workers, departments, jobs, positions, locations, grades, and absences from an Oracle Fusion Cloud HCM pod through its REST API.",
  categories: ["Productivity", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "restServerUrl",
          label: "REST Server URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "servername.fa.us2.oraclecloud.com",
          description:
            "Host name of your Oracle Fusion Cloud HCM pod, for example servername.fa.us2.oraclecloud.com. The https:// prefix is optional and any path is ignored. It is the same host you use to sign in to Fusion Applications.",
        },
        {
          key: "username",
          label: "Username",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "integration.user",
          description:
            "Fusion Applications user used for HTTP Basic authentication. Use a dedicated integration user whose roles allow reading the HR data you want to expose.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Enter password",
          description: "Password of the Fusion Applications user above.",
        },
      ],
      testAction: {
        actionName: "list_workers",
        input: { limit: 1, fields: "PersonId" },
      },
    },
  ],
  homepageUrl: "https://www.oracle.com/human-capital-management/",
  actions: oracleFusionHcmActions,
};
