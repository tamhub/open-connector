import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors, proxy } from "./executors.ts";
import { extractB1Error, normalizeServiceLayerUrl } from "./runtime.ts";

const origin = "https://b1.example.com:50000";

function credential(overrides: Record<string, string> = {}): ResolvedCredential {
  return {
    authType: "custom_credential",
    values: {
      serviceLayerUrl: "b1.example.com:50000",
      companyDb: "SBODEMO",
      username: "manager",
      password: "p@ss:word",
      ...overrides,
    },
    profile: { accountId: "x", displayName: "x", grantedScopes: [] },
    metadata: {},
  };
}

function validatorValues(): Record<string, string> {
  const resolved = credential();
  return resolved.authType === "custom_credential" ? resolved.values : {};
}

const context = (overrides?: Record<string, string>): ExecutionContext => ({
  getCredential: async () => credential(overrides),
});

function loginResponse(): Response {
  return new Response(JSON.stringify({ SessionId: "sess-1", Version: "1000190", SessionTimeout: 30 }), {
    status: 200,
    headers: [
      ["content-type", "application/json"],
      ["set-cookie", "B1SESSION=sess-1; path=/b1s; HttpOnly"],
      ["set-cookie", "ROUTEID=.node2; path=/b1s"],
    ],
  });
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/** Stub fetch with a handler for non-session calls; Login and Logout are answered here and recorded. */
function stubServiceLayer(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: input.toString(),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      if (call.url.endsWith("/Login")) return loginResponse();
      if (call.url.endsWith("/Logout")) return new Response(null, { status: 204 });
      return handler(call);
    }),
  );
  return calls;
}

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
  vi.unstubAllGlobals();
});

describe("Service Layer URL normalisation", () => {
  it("keeps an explicit port and strips pasted /b1s paths", () => {
    expect(normalizeServiceLayerUrl("b1.example.com:50000")).toBe(origin);
    expect(normalizeServiceLayerUrl("https://b1.example.com:50000/b1s/v2/Login?x=1")).toBe(origin);
    expect(normalizeServiceLayerUrl("https://b1.example.com/")).toBe("https://b1.example.com");
  });

  it("rejects http, embedded credentials, local targets and private ones unless allowed", () => {
    expect(() => normalizeServiceLayerUrl("http://b1.example.com")).toThrow("must use https");
    expect(() => normalizeServiceLayerUrl("https://u:p@b1.example.com")).toThrow("credentials");
    expect(() => normalizeServiceLayerUrl("localhost:50000")).toThrow();
    expect(() => normalizeServiceLayerUrl("169.254.169.254")).toThrow();
    expect(() => normalizeServiceLayerUrl("192.168.1.20:50000", false)).toThrow("private");
    expect(normalizeServiceLayerUrl("192.168.1.20:50000", true)).toBe("https://192.168.1.20:50000");
  });
});

describe("session handling", () => {
  it("logs in, queries with the session cookies and logs out", async () => {
    const calls = stubServiceLayer(() =>
      Response.json({
        "@odata.context": "$metadata#BusinessPartners",
        value: [{ CardCode: "C001" }],
        "@odata.count": 7,
        "@odata.nextLink": "BusinessPartners?$filter=CardType%20eq%20%27cCustomer%27&$skip=20",
      }),
    );

    const result = await executors["sap_business_one.list_business_partners"]!(
      { filter: "CardType eq 'cCustomer'", select: "CardCode", top: 20, includeCount: true },
      context(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        records: [{ CardCode: "C001" }],
        totalCount: 7,
        nextLink: "/b1s/v2/BusinessPartners?$filter=CardType%20eq%20%27cCustomer%27&$skip=20",
      },
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${origin}/b1s/v2/Login`,
      `GET ${origin}/b1s/v2/BusinessPartners?$filter=CardType%20eq%20%27cCustomer%27&$select=CardCode&$top=20&$count=true`,
      `POST ${origin}/b1s/v2/Logout`,
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ CompanyDB: "SBODEMO", UserName: "manager", Password: "p@ss:word" });
    expect(calls[1]!.headers.get("cookie")).toBe("B1SESSION=sess-1; ROUTEID=.node2");
    expect(calls[1]!.headers.get("prefer")).toBe("odata.maxpagesize=20");
    expect(calls[2]!.headers.get("cookie")).toBe("B1SESSION=sess-1; ROUTEID=.node2");
  });

  it("uses the v1 root and inlinecount when apiVersion is v1", async () => {
    const calls = stubServiceLayer(() => Response.json({ value: [], "odata.count": "0", "odata.metadata": "x" }));
    const result = await executors["sap_business_one.list_items"]!(
      { includeCount: true },
      context({ apiVersion: "v1" }),
    );
    expect(result).toEqual({ ok: true, output: { records: [], totalCount: 0 } });
    expect(calls[1]!.url).toBe(`${origin}/b1s/v1/Items?$inlinecount=allpages`);
    expect(calls[2]!.url).toBe(`${origin}/b1s/v1/Logout`);
  });

  it("still logs out and keeps the action error when the request fails", async () => {
    const calls = stubServiceLayer(() =>
      Response.json(
        { error: { code: -2028, message: { lang: "en-us", value: "No matching records found" } } },
        { status: 404 },
      ),
    );
    const result = await executors["sap_business_one.get_business_partner"]!({ key: "O'Brien & Co" }, context());

    expect(calls[1]!.url).toBe(`${origin}/b1s/v2/BusinessPartners('O''Brien%20%26%20Co')`);
    expect(calls.at(-1)!.url).toBe(`${origin}/b1s/v2/Logout`);
    expect(result).toMatchObject({ ok: false, error: { message: "No matching records found" } });
  });

  it("does not let a failing logout mask the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/Login")) return loginResponse();
        if (url.endsWith("/Logout")) throw new Error("connection reset");
        return Response.json({ CardCode: "C001", "@odata.context": "ctx" });
      }),
    );
    const result = await executors["sap_business_one.get_business_partner"]!({ key: "C001" }, context());
    expect(result).toEqual({ ok: true, output: { entity: { CardCode: "C001" } } });
  });

  it("maps a rejected login and an expired session to clear errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: -304, message: "Fail to login" } }, { status: 401 })),
    );
    const login = await executors["sap_business_one.list_items"]!({}, context());
    expect(login).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("login failed: Fail to login") },
    });

    stubServiceLayer(() => Response.json({ error: { code: 301, message: "Invalid session" } }, { status: 401 }));
    const expired = await executors["sap_business_one.list_items"]!({}, context());
    expect(expired).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("session was rejected or expired") },
    });
  });
});

describe("actions", () => {
  it("creates a sales order with only the provided line fields", async () => {
    const calls = stubServiceLayer(() => Response.json({ DocEntry: 55, DocNum: 120 }, { status: 201 }));
    const result = await executors["sap_business_one.create_sales_order"]!(
      {
        CardCode: "C001",
        DocDueDate: "2026-11-01",
        DocumentLines: [
          { ItemCode: "A1", Quantity: 3 },
          { ItemCode: "A2", Quantity: 1, Price: 9.5 },
        ],
      },
      context(),
    );
    expect(result).toEqual({ ok: true, output: { status: 201, entity: { DocEntry: 55, DocNum: 120 } } });
    expect(calls[1]).toMatchObject({ method: "POST", url: `${origin}/b1s/v2/Orders` });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      CardCode: "C001",
      DocDueDate: "2026-11-01",
      DocumentLines: [
        { ItemCode: "A1", Quantity: 3 },
        { ItemCode: "A2", Quantity: 1, Price: 9.5 },
      ],
    });
  });

  it("patches by integer or string key and rejects reserved entity sets", async () => {
    const calls = stubServiceLayer(() => new Response(null, { status: 204 }));
    const byDocEntry = await executors["sap_business_one.update_entity"]!(
      { entitySet: "Orders", key: 55, body: { Comments: "x" }, etag: 'W/"1"' },
      context(),
    );
    expect(byDocEntry).toEqual({ ok: true, output: { updated: true, status: 204 } });
    expect(calls[1]).toMatchObject({ method: "PATCH", url: `${origin}/b1s/v2/Orders(55)` });
    expect(calls[1]!.headers.get("if-match")).toBe('W/"1"');

    const reserved = await executors["sap_business_one.update_entity"]!(
      { entitySet: "Login", key: "x", body: { a: 1 } },
      context(),
    );
    expect(reserved).toMatchObject({ ok: false });
  });

  it("follows a relative next link and refuses links outside /b1s/", async () => {
    const calls = stubServiceLayer(() => Response.json({ value: [{ ItemCode: "A1" }] }));
    const ok = await executors["sap_business_one.fetch_next_page"]!({ nextLink: "Items?$skip=20" }, context());
    expect(ok).toEqual({ ok: true, output: { records: [{ ItemCode: "A1" }] } });
    expect(calls[1]!.url).toBe(`${origin}/b1s/v2/Items?$skip=20`);

    const rebased = await executors["sap_business_one.fetch_next_page"]!(
      { nextLink: "https://internal-host:50000/b1s/v2/Items?$skip=40" },
      context(),
    );
    expect(rebased).toMatchObject({ ok: true });
    expect(calls.find((call) => call.url.includes("$skip=40"))!.url).toBe(`${origin}/b1s/v2/Items?$skip=40`);

    const outside = await executors["sap_business_one.fetch_next_page"]!({ nextLink: "/other/path" }, context());
    expect(outside).toMatchObject({ ok: false });
  });
});

describe("credential validator and proxy", () => {
  it("validates by logging in and reads the company name when available", async () => {
    const calls = stubServiceLayer(() => Response.json({ CompanyName: "Demo GmbH" }));
    const result = await credentialValidators.customCredential!({ values: validatorValues() }, { fetcher: fetch });
    expect(result).toMatchObject({
      profile: {
        accountId: "b1.example.com:50000/SBODEMO/manager",
        displayName: "SAP Business One (Demo GmbH, manager)",
      },
    });
    expect(calls.map((call) => `${call.method} ${call.url.slice(origin.length)}`)).toEqual([
      "POST /b1s/v2/Login",
      "POST /b1s/v2/CompanyService_GetCompanyInfo",
      "POST /b1s/v2/Logout",
    ]);
  });

  it("reports a rejected login as a 400 validation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: -304, message: "Fail to login" } }, { status: 401 })),
    );
    await expect(
      credentialValidators.customCredential!({ values: validatorValues() }, { fetcher: fetch }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("proxies with the session cookie and logs out afterwards", async () => {
    const calls = stubServiceLayer(() => Response.json({ value: [] }));
    const result = await proxy({ method: "GET", endpoint: "/Items", query: { $top: 1 } }, context());
    expect(result.ok).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url.slice(origin.length)}`)).toEqual([
      "POST /b1s/v2/Login",
      "GET /b1s/v2/Items?%24top=1",
      "POST /b1s/v2/Logout",
    ]);
    expect(calls[1]!.headers.get("cookie")).toBe("B1SESSION=sess-1; ROUTEID=.node2");

    const blocked = await proxy({ method: "POST", endpoint: "/Logout" }, context());
    expect(blocked.ok).toBe(false);
  });
});

describe("error extraction", () => {
  it("reads v1 and v2 error shapes", () => {
    expect(extractB1Error('{"error":{"code":-1,"message":{"lang":"en","value":"v1 text"}}}', "")).toEqual({
      message: "v1 text",
      code: "-1",
    });
    expect(extractB1Error('{"error":{"code":-2,"message":"v2 text"}}', "")).toEqual({ message: "v2 text", code: "-2" });
    expect(extractB1Error("", "Bad Gateway")).toEqual({ message: "Bad Gateway" });
  });
});
