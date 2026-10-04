import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { SuccessFactorsContext } from "./runtime.ts";

import { defineProviderExecutors, defineProviderProxy, requireCustomCredential } from "../provider-runtime.ts";
import {
  createSuccessFactorsContext,
  normalizeSuccessFactorsApiServer,
  readSuccessFactorsCredentials,
  resolveSuccessFactorsAuthorization,
  successFactorsHandlers,
  validateSuccessFactorsCredential,
} from "./runtime.ts";

const service = "sap_successfactors";

export const executors: ProviderExecutors = defineProviderExecutors<SuccessFactorsContext>({
  service,
  handlers: successFactorsHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<SuccessFactorsContext> {
    const credential = await requireCustomCredential(context, service);
    return createSuccessFactorsContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "SAP SuccessFactors request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return `${normalizeSuccessFactorsApiServer(credential.values.apiServer)}/odata/v2`;
  },
  auth: { type: "none" },
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const credentials = readSuccessFactorsCredentials(credential.values);
    headers.set("authorization", await resolveSuccessFactorsAuthorization(credentials, fetcher, context.signal));
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateSuccessFactorsCredential(input.values, fetcher, signal);
  },
};
