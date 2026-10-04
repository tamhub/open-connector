import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";
import { normalizeAribaSubdomain, resolveAribaConnection, shapeAribaPage } from "./runtime.ts";

const values = {
  subdomain: "api-eu",
  clientId: "client-1",
  clientSecret: "s3cret$",
  apiKey: "app-key-1",
  realm: "Acme-T",
  anid: "an01234",
};

const credential: ResolvedCredential = {
  authType: "custom_credential",
  values,
  profile: { accountId: "x", displayName: "x", grantedScopes: [] },
  metadata: {},
};
const context: ExecutionContext = { getCredential: async () => credential };

interface Call {
  url: string;
  init?: RequestInit;
}

function stubAriba(apiResponse: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (input.toString().includes("/v2/oauth/token")) return Response.json({ access_token: "tok-1" });
      return apiResponse();
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

describe("SAP Ariba connection", () => {
  it("normalizes the data center and derives both hosts", () => {
    expect(normalizeAribaSubdomain("https://API-EU.ariba.com/")).toBe("api-eu");
    expect(normalizeAribaSubdomain("openapi.ariba.com")).toBe("api");
    const connection = resolveAribaConnection({ ...values, subdomain: "api.au.cloud" });
    expect(connection.tokenUrl).toBe("https://api.au.cloud.ariba.com/v2/oauth/token");
    expect(connection.apiBase).toBe("https://openapi.au.cloud.ariba.com");
    expect(connection.anid).toBe("AN01234");
  });

  it("rejects unknown hosts, non-https URLs and malformed ids", () => {
    expect(() => normalizeAribaSubdomain("evil.example.com")).toThrow("subdomain must be one of");
    expect(() => normalizeAribaSubdomain("http://api.ariba.com")).toThrow("https");
    expect(() => normalizeAribaSubdomain("api@evil.com#")).toThrow("subdomain must be one of");
    expect(() => resolveAribaConnection({ ...values, anid: "X12" })).toThrow("anid");
    expect(() => resolveAribaConnection({ ...values, apiKey: "" })).toThrow("apiKey");
  });
});

describe("SAP Ariba actions", () => {
  it("exchanges a token with Basic client auth, then runs a report view with apiKey and network id", async () => {
    const calls = stubAriba(() => Response.json({ Records: [{ Id: "R1" }], PageToken: "p2", count: 7 }));

    const result = await executors["sap_ariba.run_report_view"]!(
      { viewTemplateName: "Requisition_SAP_createdRange", filters: { updatedDateFrom: "2025-01-01T00:00:00Z" } },
      context,
    );

    expect(result).toEqual({ ok: true, output: { records: [{ Id: "R1" }], pageToken: "p2", totalCount: 7 } });
    const token = calls[0]!;
    expect(token.url).toBe("https://api-eu.ariba.com/v2/oauth/token");
    expect(new Headers(token.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-1:s3cret$").toString("base64")}`,
    );
    expect(token.init?.body).toBe("grant_type=openapi_2lo");

    const api = new URL(calls[1]!.url);
    expect(api.origin).toBe("https://openapi-eu.ariba.com");
    expect(api.pathname).toBe("/api/procurement-reporting-details/v2/prod/views/Requisition_SAP_createdRange");
    expect(api.searchParams.get("realm")).toBe("Acme-T");
    expect(api.searchParams.get("filters")).toBe('{"updatedDateFrom":"2025-01-01T00:00:00Z"}');
    const headers = new Headers(calls[1]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-1");
    expect(headers.get("apikey")).toBe("app-key-1");
    expect(headers.get("x-ariba-network-id")).toBe("AN01234");
  });

  it("lists pending approvables for one user and rejects combining both filters", async () => {
    const calls = stubAriba(() => Response.json({ value: [{ approvableId: "A1" }], count: 1 }));

    const ok = await executors["sap_ariba.list_pending_approvables"]!({ user: "jdoe", top: 5 }, context);
    expect(ok).toEqual({ ok: true, output: { records: [{ approvableId: "A1" }], totalCount: 1 } });
    const url = new URL(calls[1]!.url);
    expect(url.pathname).toBe("/api/approval/v2/prod/pendingApprovables");
    expect(url.searchParams.get("$filter")).toBe("user eq 'jdoe'");
    expect(url.searchParams.get("$top")).toBe("5");

    const both = await executors["sap_ariba.list_pending_approvables"]!(
      { user: "jdoe", approvableType: "invoices" },
      context,
    );
    expect(both).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("sends the approval decision as a PATCH with state and comment", async () => {
    const calls = stubAriba(() => new Response(null, { status: 200 }));

    const result = await executors["sap_ariba.decide_approvable"]!(
      { approvableType: "requisitions", approvableId: "A1", user: "jdoe", decision: "deny", comment: "too high" },
      context,
    );

    expect(result).toEqual({ ok: true, output: { submitted: true } });
    const patch = calls[1]!;
    expect(patch.init?.method).toBe("PATCH");
    expect(new URL(patch.url).pathname).toBe("/api/approval/v2/prod/requisitions/A1");
    expect(JSON.parse(patch.init?.body as string)).toEqual({
      state: "Denied",
      comment: { text: "too high", visibleToSupplier: "false" },
    });
  });

  it("queries suppliers with a POST body and the previous page token as $skip", async () => {
    const calls = stubAriba(() => Response.json({ payload: [{ smVendorId: "S1" }], pageToken: "10" }));

    const result = await executors["sap_ariba.query_suppliers"]!(
      { registrationStatuses: ["Registered"], pageToken: "5" },
      context,
    );

    expect(result).toEqual({ ok: true, output: { records: [{ smVendorId: "S1" }], pageToken: "10" } });
    const post = calls[1]!;
    expect(post.init?.method).toBe("POST");
    const url = new URL(post.url);
    expect(url.pathname).toBe("/api/supplierdatapagination/v4/prod/vendorDataRequests");
    expect(url.searchParams.get("$skip")).toBe("5");
    expect(JSON.parse(post.init?.body as string)).toEqual({
      outputFormat: "JSON",
      withQuestionnaire: false,
      registrationStatusList: ["Registered"],
    });
  });

  it("restricts query_resource to plain /api/ paths and fills in the realm", async () => {
    const calls = stubAriba(() => Response.json({ ok: 1 }));
    const ok = await executors["sap_ariba.query_resource"]!(
      { path: "api/foo/v1/prod/things", query: { a: 1 } },
      context,
    );
    expect(ok).toEqual({ ok: true, output: { data: { ok: 1 } } });
    const url = new URL(calls[1]!.url);
    expect(url.searchParams.get("realm")).toBe("Acme-T");
    expect(url.searchParams.get("a")).toBe("1");

    for (const path of ["/other/x", "/api/../x", "/api/x?y=1", "/api//x"]) {
      expect(await executors["sap_ariba.query_resource"]!({ path }, context)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("requires a realm from the connection or the input", async () => {
    stubAriba(() => Response.json({}));
    const noRealm: ExecutionContext = {
      getCredential: async () => ({ ...credential, values: { ...values, realm: "" } }),
    };
    expect(await executors["sap_ariba.list_view_templates"]!({}, noRealm)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("realm is required") },
    });
  });
});

describe("SAP Ariba errors", () => {
  it("explains a 403 as a missing API approval", async () => {
    stubAriba(() => Response.json({ message: "Forbidden" }, { status: 403 }));
    const result = await executors["sap_ariba.get_approvable"]!(
      { approvableType: "invoices", approvableId: "I1" },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: expect.stringContaining("approved for the Document Approval API"),
      },
    });
  });

  it("maps 429 to rate_limited with the Retry-After hint", async () => {
    stubAriba(() => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }));
    const result = await executors["sap_ariba.list_view_templates"]!({}, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { details: { retryAfterSeconds: 12 } } },
    });
  });

  it("maps a rejected token to authorization_failed at execute time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error_description: "Bad client" }, { status: 401 })),
    );
    const result = await executors["sap_ariba.query_resource"]!({ path: "/api/x" }, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("Bad client") },
    });
  });
});

describe("SAP Ariba credential validation", () => {
  it("probes with a token exchange and builds the profile", async () => {
    const result = await credentialValidators.customCredential!(
      { values },
      { fetcher: async () => Response.json({ access_token: "t" }) },
    );
    expect(result).toMatchObject({
      profile: { accountId: "api-eu+Acme-T+client-1" },
      metadata: { tokenEndpoint: "https://api-eu.ariba.com/v2/oauth/token", apiHost: "https://openapi-eu.ariba.com" },
    });
  });

  it("falls back to the network id and reports a bad client as a connect-form error", async () => {
    const result = await credentialValidators.customCredential!(
      { values: { ...values, realm: "" } },
      { fetcher: async () => Response.json({ access_token: "t" }) },
    );
    expect(result).toMatchObject({ profile: { accountId: "api-eu+AN01234+client-1" } });

    await expect(
      credentialValidators.customCredential!(
        { values },
        { fetcher: async () => Response.json({ error_description: "nope" }, { status: 401 }) },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("shapeAribaPage", () => {
  it("handles bare arrays and missing envelopes", () => {
    expect(shapeAribaPage([{ a: 1 }, "x"])).toEqual({ records: [{ a: 1 }] });
    expect(shapeAribaPage(null)).toEqual({ records: [] });
  });
});
