import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { SapODataContext } from "./odata-runtime.ts";

import { defineProviderExecutors, defineProviderProxy, requireCustomCredential } from "../provider-runtime.ts";
import { normalizeSapApiServer, sapODataHandlers } from "./odata-runtime.ts";
import { createSapBasicContext, validateSapBasicCredential } from "./runtime.ts";

const service = "sap_s4hana_cloud_basic";

export const executors: ProviderExecutors = defineProviderExecutors<SapODataContext>({
  service,
  handlers: sapODataHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<SapODataContext> {
    const credential = await requireCustomCredential(context, service);
    return createSapBasicContext(credential.values, fetcher, context.signal);
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
    headers.set("authorization", createSapBasicContext(credential.values, fetcher).authorization);
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateSapBasicCredential(input.values, fetcher, signal);
  },
};
