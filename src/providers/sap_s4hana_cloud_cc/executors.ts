import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { SapODataContext } from "../sap_s4hana_cloud_basic/odata-runtime.ts";

import {
  defineProviderExecutors,
  defineProviderProxy,
  mapProviderActionNames,
  requireCustomCredential,
} from "../provider-runtime.ts";
import { normalizeSapApiServer, sapODataHandlers } from "../sap_s4hana_cloud_basic/odata-runtime.ts";
import { createSapClientCredentialsContext, validateSapClientCredentials } from "./runtime.ts";

const service = "sap_s4hana_cloud_cc";

// The action set is identical to the Basic Auth provider; re-key it against this provider's generated contract.
const handlers = mapProviderActionNames(
  service,
  Object.keys(sapODataHandlers),
  (name) => sapODataHandlers[name as keyof typeof sapODataHandlers],
);

export const executors: ProviderExecutors = defineProviderExecutors<SapODataContext>({
  service,
  handlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<SapODataContext> {
    const credential = await requireCustomCredential(context, service);
    return createSapClientCredentialsContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "SAP S/4HANA Cloud request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return normalizeSapApiServer(credential.values.apiServer);
  },
  auth: { type: "none" },
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const sapContext = await createSapClientCredentialsContext(credential.values, fetcher, context.signal);
    headers.set("authorization", sapContext.authorization);
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateSapClientCredentials(input.values, fetcher, signal);
  },
};
