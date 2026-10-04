import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { B1Context, B1SessionHandle } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  createProviderFetch,
  defineProviderExecutors,
  defineProviderProxy,
  requireCustomCredential,
  runProviderRequest,
} from "../provider-runtime.ts";
import { sapBusinessOneHandlers } from "./handlers.ts";
import {
  createB1Context,
  login,
  logoutQuietly,
  normalizeServiceLayerUrl,
  resolveApiVersion,
  sessionHandle,
  validateB1Credential,
} from "./runtime.ts";

const service = "sap_business_one";

export const executors: ProviderExecutors = defineProviderExecutors<B1Context>({
  service,
  handlers: sapBusinessOneHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<B1Context> {
    const credential = await requireCustomCredential(context, service);
    return createB1Context(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "SAP Business One request failed",
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

// `defineProviderProxy` can log in and inject the session cookie through `customizeRequest`, but it
// has no hook after the response. The sessions opened for a call are therefore recorded here and
// closed by the wrapper below, so proxied calls do not leave licence-consuming sessions behind.
const openProxySessions = new WeakMap<ExecutionContext, B1SessionHandle[]>();

const innerProxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    const origin = normalizeServiceLayerUrl(credential.values.serviceLayerUrl);
    return `${origin}/b1s/${resolveApiVersion(credential.values.apiVersion)}`;
  },
  auth: { type: "none" },
  allowedEndpoint: (endpoint) => !/^\/?(login|logout)(\/|\?|$)/iu.test(endpoint),
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireCustomCredential(context, service);
    const b1 = createB1Context(credential.values, fetcher, context.signal);
    const session = await runProviderRequest({ signal: context.signal, label: "SAP Business One" }, (signal) =>
      login(b1, signal),
    );
    openProxySessions.set(context, [...(openProxySessions.get(context) ?? []), sessionHandle(b1, session)]);
    headers.delete("authorization");
    headers.set("cookie", session.cookie);
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
  sensitiveHeaders: ["cookie"],
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const proxy: ProviderProxyExecutor = async (input, context) => {
  // A per-call identity that still reads everything from the caller's context, so two concurrent
  // proxy calls sharing one context never log out each other's sessions.
  const callContext: ExecutionContext = Object.create(context) as ExecutionContext;
  try {
    return await innerProxy(input, callContext);
  } finally {
    const sessions = openProxySessions.get(callContext) ?? [];
    openProxySessions.delete(callContext);
    await Promise.all(sessions.map((handle) => logoutQuietly(handle)));
  }
};

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    // Re-guard the shared validator fetcher with the private-network opt-in so validating a
    // private Service Layer works when the deployment allows it.
    const guardedFetcher = createProviderFetch({ fetch: fetcher, allowPrivateNetwork: isPrivateNetworkAccessAllowed });
    return validateB1Credential(input.values, guardedFetcher, signal);
  },
};
