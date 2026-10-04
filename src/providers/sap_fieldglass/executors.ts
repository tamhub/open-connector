import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { FieldglassContext } from "./runtime.ts";

import { defineProviderExecutors, defineProviderProxy, requireCustomCredential } from "../provider-runtime.ts";
import {
  createFieldglassContext,
  fieldglassApiBase,
  fieldglassHandlers,
  normalizeFieldglassDomain,
  validateFieldglassCredentials,
} from "./runtime.ts";

const service = "sap_fieldglass";

export const executors: ProviderExecutors = defineProviderExecutors<FieldglassContext>({
  service,
  handlers: fieldglassHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<FieldglassContext> {
    const credential = await requireCustomCredential(context, service);
    return createFieldglassContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "SAP Fieldglass request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return fieldglassApiBase(normalizeFieldglassDomain(credential.values.domain));
  },
  auth: { type: "none" },
  sensitiveHeaders: ["x-applicationkey"],
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const fieldglass = await createFieldglassContext(credential.values, fetcher, context.signal);
    headers.set("authorization", fieldglass.authorization);
    if (fieldglass.appKey) headers.set("x-applicationkey", fieldglass.appKey);
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateFieldglassCredentials(input.values, fetcher, signal);
  },
};
