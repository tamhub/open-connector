import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";
import { extractSapError, normalizeSapApiServer } from "./odata-runtime.ts";

function credential(overrides: Record<string, string> = {}): ResolvedCredential {
  return {
    authType: "custom_credential",
    values: { apiServer: "my123456-api.s4hana.cloud.sap", username: "COMM_USER", password: "p@ss:word", ...overrides },
    profile: { accountId: "x", displayName: "x", grantedScopes: [] },
    metadata: {},
  };
}

const context = (overrides?: Record<string, string>): ExecutionContext => ({
  getCredential: async () => credential(overrides),
});

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
  vi.unstubAllGlobals();
});

describe("SAP API server normalisation", () => {
  it("accepts bare hosts, ports and https URLs and drops paths", () => {
    expect(normalizeSapApiServer("my1-api.s4hana.cloud.sap")).toBe("https://my1-api.s4hana.cloud.sap");
    expect(normalizeSapApiServer("https://eu10.cfapps.eu10.hana.ondemand.com:8443/some/path/")).toBe(
      "https://eu10.cfapps.eu10.hana.ondemand.com:8443",
    );
  });

  it("rejects http, credentials in the URL and private targets", () => {
    expect(() => normalizeSapApiServer("http://my1-api.s4hana.cloud.sap")).toThrow("must use https");
    expect(() => normalizeSapApiServer("https://u:p@my1-api.s4hana.cloud.sap")).toThrow("credentials");
    expect(() => normalizeSapApiServer("169.254.169.254")).toThrow();
    expect(() => normalizeSapApiServer("localhost")).toThrow();
  });
});

describe("SAP OData actions", () => {
  it("builds a v2 query with Basic auth and unwraps d.results, count and paging", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        "https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$filter=SoldToParty%20eq%20%271%27&$select=SalesOrder&$top=5&$skip=10&$inlinecount=allpages&$format=json",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("COMM_USER:p@ss:word").toString("base64")}`);
      expect(headers.get("accept")).toBe("application/json");
      return Response.json({
        d: {
          results: [{ SalesOrder: "1" }],
          __count: "42",
          __next: "https://my123456.s4hana.cloud.sap/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$skiptoken=15",
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_basic.list_sales_orders"]!(
      { filter: "SoldToParty eq '1'", select: "SalesOrder", top: 5, skip: 10, includeCount: true },
      context(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        records: [{ SalesOrder: "1" }],
        totalCount: 42,
        nextLink: "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$skiptoken=15",
      },
    });
  });

  it("reads a v4 collection from the generic query action and defaults top to 50", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe("https://my123456-api.s4hana.cloud.sap/odata/v4/svc/Items?$top=50");
      return Response.json({ value: [{ id: 1 }], "@odata.nextLink": "Items?$skiptoken=50" });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_basic.query_entity_set"]!(
      { servicePath: "odata/v4/svc/", entitySet: "Items", odataVersion: "v4" },
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: { records: [{ id: 1 }], nextLink: "/odata/v4/svc/Items?$skiptoken=50" },
    });
  });

  it("encodes a composite key and unwraps a single v2 entity", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe(
        "https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderItem(SalesOrder='1',SalesOrderItem='10')?$format=json",
      );
      return Response.json({ d: { SalesOrder: "1" } });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_basic.get_entity"]!(
      {
        servicePath: "/sap/opu/odata/sap/API_SALES_ORDER_SRV",
        entitySet: "A_SalesOrderItem",
        key: "SalesOrder='1',SalesOrderItem='10'",
      },
      context(),
    );

    expect(result).toEqual({ ok: true, output: { entity: { SalesOrder: "1" } } });
  });

  it("rejects service paths that climb directories or carry a query, and keeps // on the API host", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString().startsWith("https://my123456-api.s4hana.cloud.sap/")).toBe(true);
      return Response.json({ value: [] });
    });
    vi.stubGlobal("fetch", fetch);
    for (const servicePath of ["/sap/../admin", "/sap/x?y=1", "/sap/x#frag", "/sap/x y"]) {
      const result = await executors["sap_s4hana_cloud_basic.query_entity_set"]!(
        { servicePath, entitySet: "A_X" },
        context(),
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(fetch).not.toHaveBeenCalled();

    await executors["sap_s4hana_cloud_basic.query_entity_set"]!(
      { servicePath: "//evil.example/x", entitySet: "A_X", odataVersion: "v4" },
      context(),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("re-bases a paging link onto the configured API host", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe(
        "https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product?$skiptoken=50",
      );
      return Response.json({ d: { results: [] } });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_basic.fetch_next_page"]!(
      { nextLink: "https://internal.example/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product?$skiptoken=50" },
      context(),
    );

    expect(result).toEqual({ ok: true, output: { records: [] } });
  });

  it("performs the CSRF handshake and reuses token and cookies on create", async () => {
    const calls: { url: string; method: string; headers: Headers; body?: unknown }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: input.toString(), method: init?.method ?? "GET", headers, body: init?.body });
      if (calls.length === 1) {
        const response = new Response("<service/>", { status: 200, headers: { "x-csrf-token": "tok-1" } });
        response.headers.append("set-cookie", "SAP_SESSIONID=abc; Path=/; HttpOnly");
        response.headers.append("set-cookie", "sap-usercontext=lang=EN; Path=/");
        return response;
      }
      return Response.json({ d: { BusinessPartner: "1000001" } }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_basic.create_entity"]!(
      {
        servicePath: "/sap/opu/odata/sap/API_BUSINESS_PARTNER",
        entitySet: "A_BusinessPartner",
        body: { BusinessPartnerCategory: "1" },
      },
      context(),
    );

    expect(result).toEqual({ ok: true, output: { status: 201, entity: { BusinessPartner: "1000001" } } });
    expect(calls[0]!.url).toBe("https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_BUSINESS_PARTNER/");
    expect(calls[0]!.headers.get("x-csrf-token")).toBe("fetch");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers.get("x-csrf-token")).toBe("tok-1");
    expect(calls[1]!.headers.get("cookie")).toBe("SAP_SESSIONID=abc; sap-usercontext=lang=EN");
    expect(calls[1]!.headers.get("content-type")).toBe("application/json");
    expect(calls[1]!.body).toBe(JSON.stringify({ BusinessPartnerCategory: "1" }));
  });

  it("sends PATCH with If-Match and treats 204 as success", async () => {
    const calls: { method: string; headers: Headers }[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return calls.length === 1
        ? new Response(null, { status: 200, headers: { "x-csrf-token": "t" } })
        : new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_s4hana_cloud_basic.update_entity"]!(
      {
        servicePath: "/sap/opu/odata/sap/API_BUSINESS_PARTNER",
        entitySet: "A_BusinessPartner",
        key: "'1000001'",
        body: { OrganizationBPName1: "ACME" },
        etag: 'W/"abc"',
      },
      context(),
    );

    expect(result).toEqual({ ok: true, output: { updated: true, status: 204 } });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.headers.get("if-match")).toBe('W/"abc"');
  });

  it("maps OData v2 and v4 error bodies and auth failures", async () => {
    expect(
      extractSapError(JSON.stringify({ error: { code: "X", message: { lang: "en", value: "v2 text" } } }), ""),
    ).toEqual({
      message: "v2 text",
      code: "X",
    });
    expect(extractSapError(JSON.stringify({ error: { code: "Y", message: "v4 text" } }), "")).toMatchObject({
      message: "v4 text",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: { value: "Not authorized" } } }, { status: 403 })),
    );
    const result = await executors["sap_s4hana_cloud_basic.list_products"]!({}, context());
    expect(result).toMatchObject({ ok: false, error: { code: "authorization_failed", message: "Not authorized" } });
  });
});

describe("SAP Basic credential validation", () => {
  it("probes the Business Partner service and returns host + user as the account id", async () => {
    const result = await credentialValidators.customCredential!(
      { values: { apiServer: "my123456-api.s4hana.cloud.sap", username: "COMM_USER", password: "p@ss:word" } },
      {
        fetcher: async (url, init) => {
          expect(url.toString()).toBe(
            "https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=1&$select=BusinessPartner&$format=json",
          );
          expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
          return Response.json({ d: { results: [] } });
        },
      },
    );
    expect(result).toMatchObject({
      profile: { accountId: "my123456-api.s4hana.cloud.sap+COMM_USER" },
      metadata: { apiServer: "https://my123456-api.s4hana.cloud.sap" },
    });
  });

  it("reports rejected credentials as a field error", async () => {
    await expect(
      credentialValidators.customCredential!(
        { values: { apiServer: "my1-api.s4hana.cloud.sap", username: "u", password: "bad" } },
        { fetcher: async () => new Response("Unauthorized", { status: 401 }) },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
