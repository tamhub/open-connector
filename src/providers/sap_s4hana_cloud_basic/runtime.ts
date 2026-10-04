import type { CredentialValidationResult } from "../../core/types.ts";
import type { SapODataContext } from "./odata-runtime.ts";

import { requiredString } from "../../core/cast.ts";
import { basicAuthorizationHeader, providerInputError } from "../provider-runtime.ts";
import { normalizeSapApiServer, validateSapODataConnection } from "./odata-runtime.ts";

export function createSapBasicContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): SapODataContext {
  const username = requiredString(values.username, "username", providerInputError);
  // The password is used verbatim: trimming would silently change a valid secret.
  const password = values.password;
  if (!password) throw providerInputError("password is required.");
  return {
    baseUrl: normalizeSapApiServer(values.apiServer),
    authorization: basicAuthorizationHeader(`${username}:${password}`),
    fetcher,
    signal,
  };
}

export function validateSapBasicCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createSapBasicContext(values, fetcher, signal);
  return validateSapODataConnection(context, values.username!.trim());
}
