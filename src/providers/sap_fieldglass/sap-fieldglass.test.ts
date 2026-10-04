import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors, proxy } from "./executors.ts";
import { normalizeFieldglassDomain, normalizeResourcePath, parseCsv } from "./runtime.ts";

const values = {
  domain: "https://Acme-fgvms.com/",
  clientId: "api.user",
  clientSecret: "s3cret$",
  appKey: "app-key-123",
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

function stubFieldglass(handler: (url: URL, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      const url = new URL(input.toString());
      if (url.pathname === "/api/oauth2/v2.0/token") {
        return Response.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 7200 });
      }
      return handler(url, init);
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

describe("SAP Fieldglass host handling", () => {
  it("normalizes the environment host and enforces the allowlist", () => {
    expect(normalizeFieldglassDomain("https://Acme-fgvms.com/api/x")).toBe("acme-fgvms.com");
    expect(normalizeFieldglassDomain("acme-auth.fgvms.com")).toBe("acme-auth.fgvms.com");
    expect(normalizeFieldglassDomain("auth.fieldglass.net")).toBe("auth.fieldglass.net");
    expect(normalizeFieldglassDomain("sso.fieldglass.eu")).toBe("sso.fieldglass.eu");
    expect(normalizeFieldglassDomain("acme.fgvms.com")).toBe("acme.fgvms.com");
    expect(normalizeFieldglassDomain("www.fieldglass.net")).toBe("www.fieldglass.net");
    expect(normalizeFieldglassDomain("acme-auth.eu.fieldglass.eu")).toBe("acme-auth.eu.fieldglass.eu");
    expect(() => normalizeFieldglassDomain("fieldglass.net.evil.com")).toThrow("Fieldglass environment host");
    expect(() => normalizeFieldglassDomain("evilfieldglass.net")).toThrow("Fieldglass environment host");
    expect(() => normalizeFieldglassDomain("http://acme-fgvms.com")).toThrow("https");
    expect(() => normalizeFieldglassDomain("evil.example.com")).toThrow("Fieldglass environment host");
    expect(() => normalizeFieldglassDomain("acme-fgvms.com.evil.com")).toThrow("Fieldglass environment host");
    expect(() => normalizeFieldglassDomain("user:pw@acme-fgvms.com")).toThrow("credentials");
    expect(() => normalizeFieldglassDomain("acme-fgvms.com:8443")).toThrow("port");
  });

  it("keeps query_resource paths under /api", () => {
    expect(normalizeResourcePath("/api/v1/approvals/")).toBe("/v1/approvals");
    expect(normalizeResourcePath("vc/connector/x")).toBe("/vc/connector/x");
    expect(() => normalizeResourcePath("../secret")).toThrow("path");
    expect(() => normalizeResourcePath("v1/%2e%2e/x")).toThrow("path");
    expect(() => normalizeResourcePath("https://evil.example/x")).toThrow("relative");
    expect(() => normalizeResourcePath("v1/a?b=1")).toThrow("path");
  });

  it("parses quoted CSV fields", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n1,2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["1", "2"],
    ]);
  });
});

describe("SAP Fieldglass token and requests", () => {
  it("omits X-ApplicationKey when no application key is configured", async () => {
    const withoutKey: ResolvedCredential = { ...credential, values: { ...values, appKey: "" } };
    const calls = stubFieldglass(() => Response.json({ HEADER: { Status: "ok", NumRecs: 0 }, PAYLOAD: [] }));

    await executors["sap_fieldglass.list_pending_approvals"]!({}, { getCredential: async () => withoutKey });

    expect(new Headers(calls[0]!.init?.headers).has("x-applicationkey")).toBe(false);
    expect(new Headers(calls[1]!.init?.headers).has("x-applicationkey")).toBe(false);
  });

  it("exchanges a token per call with Basic auth and the application key, then sends Bearer", async () => {
    const calls = stubFieldglass(() =>
      Response.json({
        HEADER: { Status: "ok", NumRecs: 1 },
        PAYLOAD: [
          {
            ModuleID: "40",
            ModuleName: "Job Posting",
            ID: "z1",
            Attributes: { ref: "JP1", name: "Dev", uom: "USD", amount: "100.00", status: "Pending Approval" },
          },
        ],
      }),
    );

    const result = await executors["sap_fieldglass.list_pending_approvals"]!(
      { moduleId: "40", forUser: "bob" },
      context,
    );

    expect(result).toEqual({
      ok: true,
      output: {
        count: 1,
        items: [
          {
            moduleId: "40",
            moduleName: "Job Posting",
            id: "z1",
            reference: "JP1",
            name: "Dev",
            amount: "100.00",
            currency: "USD",
            status: "Pending Approval",
            attributes: { ref: "JP1", name: "Dev", uom: "USD", amount: "100.00", status: "Pending Approval" },
          },
        ],
      },
    });
    const token = calls[0]!;
    expect(token.url).toBe(
      "https://acme-fgvms.com/api/oauth2/v2.0/token?grant_type=client_credentials&response_type=token",
    );
    expect(token.init?.method).toBe("POST");
    const tokenHeaders = new Headers(token.init?.headers);
    expect(tokenHeaders.get("authorization")).toBe(`Basic ${Buffer.from("api.user:s3cret$").toString("base64")}`);
    expect(tokenHeaders.get("x-applicationkey")).toBe("app-key-123");
    expect(calls[1]!.url).toBe("https://acme-fgvms.com/api/v1/approvals/module_40?for_user=bob");
    const apiHeaders = new Headers(calls[1]!.init?.headers);
    expect(apiHeaders.get("authorization")).toBe("Bearer tok-1");
    expect(apiHeaders.get("x-applicationkey")).toBe("app-key-123");
  });

  it("posts a rejection with reason and comment in the query", async () => {
    const calls = stubFieldglass(() => Response.json({ HEADER: { Status: "ok", Details: "all ok" } }));
    const result = await executors["sap_fieldglass.reject_item"]!(
      { moduleId: "70", workItemId: "z9", reasonId: "r1", comments: "too high" },
      context,
    );
    expect(result).toMatchObject({ ok: true, output: { rejected: true } });
    expect(calls[1]!.init?.method).toBe("POST");
    expect(calls[1]!.url).toBe(
      "https://acme-fgvms.com/api/v1/approvals/module_70/z9/action/reject?reasonId=r1&comments=too%20high",
    );
  });

  it("runs a download connector with positional parameters and parses CSV with a cap", async () => {
    const calls = stubFieldglass(
      () => new Response("id,name\n1,Ann\n2,Bo\n3,Cy\n", { headers: { "content-type": "text/csv" } }),
    );
    const result = await executors["sap_fieldglass.run_download_connector"]!(
      { connectorName: "worker_download", parameters: ["2026-01-01", "Y"], maxRecords: 2 },
      context,
    );
    expect(result).toEqual({
      ok: true,
      output: {
        format: "csv",
        records: [
          { id: "1", name: "Ann" },
          { id: "2", name: "Bo" },
        ],
        totalRecords: 3,
        truncated: true,
      },
    });
    expect(calls[1]!.url).toBe("https://acme-fgvms.com/api/vc/connector/worker_download?__p1=2026-01-01&__p2=Y");
  });

  it("rejects a hostile connector name before any API request", async () => {
    const calls = stubFieldglass(() => Response.json({}));
    const result = await executors["sap_fieldglass.run_download_connector"]!({ connectorName: "../x" }, context);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // Only the per-call token exchange happened; no connector request was sent.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/oauth2/v2.0/token"]);
  });

  it("maps a token rejection to authorization_failed and an API 403 likewise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error_description: "Bad credentials" }, { status: 401 })),
    );
    expect(await executors["sap_fieldglass.list_pending_approvals"]!({}, context)).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("Bad credentials") },
    });

    stubFieldglass(() =>
      Response.json({ HEADER: { Status: "error", Details: "Token not verified" } }, { status: 403 }),
    );
    expect(await executors["sap_fieldglass.query_resource"]!({ path: "v1/approvals" }, context)).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: "Token not verified" },
    });
  });

  it("maps a Fieldglass error status in a 200 approvals body to invalid_input", async () => {
    stubFieldglass(() => Response.json({ HEADER: { Status: "error", Details: "Unknown module" }, PAYLOAD: [] }));
    expect(await executors["sap_fieldglass.list_pending_approvals"]!({}, context)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Unknown module" },
    });
  });
});

describe("SAP Fieldglass credential validation and proxy", () => {
  it("validates by token exchange and builds the profile from host and client id", async () => {
    const result = await credentialValidators.customCredential!(
      { values },
      { fetcher: async () => Response.json({ access_token: "t", expires_in: 7200 }) },
    );
    expect(result).toMatchObject({
      profile: { accountId: "acme-fgvms.com+api.user", displayName: "SAP Fieldglass (acme-fgvms.com)" },
    });
  });

  it("reports a rejected token as a connect-form error and rejects foreign hosts", async () => {
    await expect(
      credentialValidators.customCredential!(
        { values },
        { fetcher: async () => Response.json({ error: "unauthorized" }, { status: 401 }) },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      credentialValidators.customCredential!(
        { values: { ...values, domain: "evil.example.com" } },
        { fetcher: async () => Response.json({ access_token: "t" }) },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("proxies under /api with Bearer and the application key injected", async () => {
    const calls = stubFieldglass(() => Response.json({ ok: 1 }));
    const result = await proxy(
      {
        method: "GET",
        endpoint: "/v1/approvals",
        query: { for_user: "bob" },
        headers: { "x-applicationkey": "spoof" },
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(calls[1]!.url).toBe("https://acme-fgvms.com/api/v1/approvals?for_user=bob");
    const headers = new Headers(calls[1]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-1");
    expect(headers.get("x-applicationkey")).toBe("app-key-123");
  });
});
