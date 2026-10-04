import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";
import { resolveSapTokenUrl } from "./runtime.ts";

const values = {
  apiServer: "https://my123456-api.s4hana.cloud.sap/",
  subdomain: "my-sub",
  region: "eu10",
  clientId: "sb-client!b1",
  clientSecret: "s3cret$",
  scopes: "API_A, API_B",
};

const credential: ResolvedCredential = {
  authType: "custom_credential",
  values,
  profile: { accountId: "x", displayName: "x", grantedScopes: [] },
  metadata: {},
};
const context: ExecutionContext = { getCredential: async () => credential };

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
  vi.unstubAllGlobals();
});

describe("SAP client credentials", () => {
  it("builds the token URL and rejects hostile subdomains or regions", () => {
    expect(resolveSapTokenUrl(values)).toBe("https://my-sub.authentication.eu10.hana.ondemand.com/oauth/token");
    expect(() => resolveSapTokenUrl({ ...values, subdomain: "evil.example/x" })).toThrow("subdomain");
    expect(() => resolveSapTokenUrl({ ...values, region: "eu10.evil.com#" })).toThrow("region");
  });

  it("exchanges a token per call with Basic client auth, then calls the API with Bearer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (input.toString().includes("/oauth/token")) {
        return Response.json({ access_token: "bearer-1", token_type: "bearer", expires_in: 43199 });
      }
      return Response.json({ d: { results: [{ Product: "P1" }] } });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_cc.list_products"]!({ top: 2 }, context);

    expect(result).toEqual({ ok: true, output: { records: [{ Product: "P1" }] } });
    const token = calls[0]!;
    expect(token.url).toBe("https://my-sub.authentication.eu10.hana.ondemand.com/oauth/token");
    expect(token.init?.method).toBe("POST");
    const tokenHeaders = new Headers(token.init?.headers);
    expect(tokenHeaders.get("authorization")).toBe(`Basic ${Buffer.from("sb-client!b1:s3cret$").toString("base64")}`);
    expect(tokenHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(token.init?.body as string).toString()).toBe(
      "grant_type=client_credentials&scope=API_A+API_B",
    );
    expect(calls[1]!.url).toBe(
      "https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product?$top=2&$format=json",
    );
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer bearer-1");
  });

  it("maps a token rejection to authorization_failed at execute time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "unauthorized", error_description: "Bad credentials" }, { status: 401 }),
      ),
    );
    const result = await executors["sap_s4hana_cloud_cc.list_products"]!({}, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("Bad credentials") },
    });
  });

  it("validates by token exchange plus a Business Partner probe", async () => {
    const result = await credentialValidators.customCredential!(
      { values },
      {
        fetcher: async (url) =>
          url.toString().includes("/oauth/token")
            ? Response.json({ access_token: "t" })
            : Response.json({ d: { results: [] } }),
      },
    );
    expect(result).toMatchObject({
      profile: { accountId: "my123456-api.s4hana.cloud.sap+sb-client!b1" },
      metadata: { tokenEndpoint: "https://my-sub.authentication.eu10.hana.ondemand.com/oauth/token" },
    });
  });

  it("reports a rejected token as a connect-form error", async () => {
    await expect(
      credentialValidators.customCredential!(
        { values },
        { fetcher: async () => Response.json({ error_description: "nope" }, { status: 401 }) },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
