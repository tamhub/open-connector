import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { OracleFusionHcmContext } from "./runtime.ts";

import {
  basicAuthorizationHeader,
  defineProviderExecutors,
  defineProviderProxy,
  providerProxyEndpointPrefixes,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  createOracleFusionHcmContext,
  normalizeOracleFusionHcmBaseUrl,
  oracleFusionHcmActionHandlers,
  validateOracleFusionHcmCredential,
} from "./runtime.ts";

const service = "oracle_fusion_hcm";

export const executors: ProviderExecutors = defineProviderExecutors<OracleFusionHcmContext>({
  service,
  handlers: oracleFusionHcmActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<OracleFusionHcmContext> {
    const credential = await requireCustomCredential(context, service);
    return createOracleFusionHcmContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "Oracle HCM request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return normalizeOracleFusionHcmBaseUrl(credential.values.restServerUrl);
  },
  auth: { type: "none" },
  allowedEndpoint: providerProxyEndpointPrefixes("/hcmRestApi"),
  async customizeRequest({ context, headers }) {
    const { username, password } = createOracleFusionHcmContext(
      (await requireCustomCredential(context, service)).values,
      fetch,
    );
    headers.set("authorization", basicAuthorizationHeader(`${username}:${password}`));
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
    if (!headers.has("rest-framework-version")) {
      headers.set("rest-framework-version", "4");
    }
  },
  sensitiveHeaders: ["authorization"],
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateOracleFusionHcmCredential(input.values, fetcher, signal);
  },
};
