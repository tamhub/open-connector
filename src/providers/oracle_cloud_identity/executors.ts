import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { OracleCloudIdentityContext } from "./runtime.ts";

import {
  defineProviderExecutors,
  defineProviderProxy,
  providerProxyEndpointPrefixes,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  createOracleCloudIdentityContext,
  normalizeOracleCloudIdentityHost,
  oracleCloudIdentityActionHandlers,
  validateOracleCloudIdentityCredential,
} from "./runtime.ts";

const service = "oracle_cloud_identity";

export const executors: ProviderExecutors = defineProviderExecutors<OracleCloudIdentityContext>({
  service,
  handlers: oracleCloudIdentityActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<OracleCloudIdentityContext> {
    const credential = await requireCustomCredential(context, service);
    return createOracleCloudIdentityContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "Oracle Cloud Identity request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return `https://${normalizeOracleCloudIdentityHost(credential.values.serviceInstance)}`;
  },
  auth: { type: "none" },
  allowedEndpoint: providerProxyEndpointPrefixes("/admin/v1"),
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const identity = await createOracleCloudIdentityContext(credential.values, fetcher, context.signal);
    headers.set("authorization", identity.authorization);
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
  sensitiveHeaders: ["authorization"],
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateOracleCloudIdentityCredential(input.values, fetcher, signal);
  },
};
