import type { CredentialValidationResult } from "../../core/types.ts";
import type { SapODataContext } from "../sap_s4hana_cloud_basic/odata-runtime.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  basicAuthorizationHeader,
  parseProviderJsonBodyText,
  providerInputError,
  ProviderRequestError,
  providerUserAgent,
  readProviderErrorTextBody,
  readProviderTextBody,
  runProviderRequest,
} from "../provider-runtime.ts";
import {
  extractSapError,
  normalizeSapApiServer,
  validateSapODataConnection,
} from "../sap_s4hana_cloud_basic/odata-runtime.ts";

type TokenPhase = "validate" | "execute";

interface SapClientCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export function resolveSapTokenUrl(values: Record<string, string>): string {
  const subdomain = requiredString(values.subdomain, "subdomain", providerInputError).toLowerCase();
  if (!/^[a-z0-9_-]+$/u.test(subdomain)) {
    throw providerInputError("subdomain may only contain lowercase letters, digits, hyphens and underscores");
  }
  const region = requiredString(values.region, "region", providerInputError).toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(region)) {
    throw providerInputError("region may only contain lowercase letters, digits and hyphens, for example eu10");
  }
  const url = assertPublicHttpUrl(`https://${subdomain}.authentication.${region}.hana.ondemand.com/oauth/token`, {
    fieldName: "token endpoint",
    createError: providerInputError,
  });
  return url.toString();
}

function readClientCredentials(values: Record<string, string>): SapClientCredentials {
  const clientSecret = values.clientSecret;
  if (!clientSecret) throw providerInputError("clientSecret is required.");
  return {
    tokenUrl: resolveSapTokenUrl(values),
    clientId: requiredString(values.clientId, "clientId", providerInputError),
    clientSecret,
    scopes: (values.scopes ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}

/** Exchange the client credentials for a short-lived bearer token. Called once per action. */
async function exchangeToken(
  credentials: SapClientCredentials,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  phase: TokenPhase,
): Promise<string> {
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (credentials.scopes.length > 0) form.set("scope", credentials.scopes.join(" "));
  return runProviderRequest({ signal, label: "SAP BTP token" }, async (requestSignal) => {
    const response = await fetcher(credentials.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: basicAuthorizationHeader(`${credentials.clientId}:${credentials.clientSecret}`),
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": providerUserAgent,
      },
      body: form.toString(),
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await readProviderErrorTextBody(response, "SAP BTP token error response");
      const description = optionalString(optionalRecord(safeJson(text))?.error_description);
      const message = description ?? extractSapError(text, response.statusText).message;
      throw new ProviderRequestError(
        phase === "validate" && response.status < 500 && response.status !== 429 ? 400 : response.status,
        `SAP BTP token request failed: ${message}`,
      );
    }
    const text = await readProviderTextBody(response, "SAP BTP token response");
    const payload = optionalRecord(
      parseProviderJsonBodyText(text, { emptyBody: null, invalidJsonMessage: "SAP BTP returned a malformed token" }),
    );
    const accessToken = optionalString(payload?.access_token);
    if (!accessToken) throw new ProviderRequestError(502, "SAP BTP token response did not include an access_token");
    return accessToken;
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function createSapClientCredentialsContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  phase: TokenPhase = "execute",
): Promise<SapODataContext> {
  const baseUrl = normalizeSapApiServer(values.apiServer);
  const credentials = readClientCredentials(values);
  const accessToken = await exchangeToken(credentials, fetcher, signal, phase);
  return { baseUrl, authorization: `Bearer ${accessToken}`, fetcher, signal };
}

export async function validateSapClientCredentials(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = await createSapClientCredentialsContext(values, fetcher, signal, "validate");
  const result = await validateSapODataConnection(context, values.clientId!.trim());
  return { ...result, metadata: { ...result.metadata, tokenEndpoint: resolveSapTokenUrl(values) } };
}
