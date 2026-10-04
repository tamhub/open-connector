import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";
import { normalizeConcurDatacenter, resolveConcurConnection, validatedGeolocation } from "./runtime.ts";

const values = {
  datacenter: "us2",
  clientId: "client-1",
  clientSecret: "s3cret&",
  refreshToken: "refresh-1",
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

function tokenResponse(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: "tok-1",
    expires_in: 3600,
    refresh_token: "refresh-1",
    geolocation: "https://eu2.api.concursolutions.com",
    ...extra,
  });
}

function stubConcur(apiResponse: () => Response, token: () => Response = tokenResponse): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (input.toString().includes("/oauth2/v0/token")) return token();
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

describe("SAP Concur connection", () => {
  it("maps region codes and hosts to the token host", () => {
    expect(normalizeConcurDatacenter("EU2")).toBe("eu2.api.concursolutions.com");
    expect(normalizeConcurDatacenter("https://us.api.concursolutions.com/")).toBe("us.api.concursolutions.com");
    expect(resolveConcurConnection(values).tokenUrl).toBe("https://us2.api.concursolutions.com/oauth2/v0/token");
  });

  it("rejects unknown hosts, non-https URLs and missing secrets", () => {
    expect(() => normalizeConcurDatacenter("evil.example.com")).toThrow("datacenter must be one of");
    expect(() => normalizeConcurDatacenter("http://us.api.concursolutions.com")).toThrow("https");
    expect(() => resolveConcurConnection({ ...values, refreshToken: " " })).toThrow("refreshToken");
    expect(() => resolveConcurConnection({ ...values, clientSecret: "" })).toThrow("clientSecret");
  });

  it("only trusts https geolocations on Concur domains", () => {
    expect(validatedGeolocation("https://eu2.api.concursolutions.com/")).toBe("https://eu2.api.concursolutions.com");
    expect(validatedGeolocation("http://eu2.api.concursolutions.com")).toBeUndefined();
    expect(validatedGeolocation("https://concursolutions.com.evil.io")).toBeUndefined();
    expect(validatedGeolocation("https://evil.example.com")).toBeUndefined();
  });
});

describe("SAP Concur actions", () => {
  it("refreshes the token with a form body, then lists company-wide reports on the geolocation host", async () => {
    const calls = stubConcur(() =>
      Response.json({
        Items: [{ ID: "R1" }],
        NextPage: "https://eu2.api.concursolutions.com/api/v3.0/expense/reports?offset=25&limit=25",
      }),
    );

    const result = await executors["sap_concur.list_expense_reports"]!(
      { approvalStatusCode: "A_PEND", modifiedDateAfter: "2025-01-01", limit: 25 },
      context,
    );

    expect(result).toEqual({ ok: true, output: { reports: [{ ID: "R1" }], nextOffset: "25" } });
    const token = calls[0]!;
    expect(token.url).toBe("https://us2.api.concursolutions.com/oauth2/v0/token");
    const form = new URLSearchParams(token.init?.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      client_id: "client-1",
      client_secret: "s3cret&",
      refresh_token: "refresh-1",
    });

    const api = new URL(calls[1]!.url);
    expect(api.origin).toBe("https://eu2.api.concursolutions.com");
    expect(api.pathname).toBe("/api/v3.0/expense/reports");
    expect(api.searchParams.get("user")).toBe("ALL");
    expect(api.searchParams.get("approvalStatusCode")).toBe("A_PEND");
    expect(api.searchParams.get("modifiedDateAfter")).toBe("2025-01-01");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer tok-1");
  });

  it("falls back to the datacenter host when the geolocation is not a Concur host", async () => {
    const calls = stubConcur(
      () => Response.json({ Resources: [{ id: "u1" }], totalResults: 1, itemsPerPage: 1, startIndex: 1 }),
      () => tokenResponse({ geolocation: "https://evil.example.com" }),
    );
    const result = await executors["sap_concur.list_users"]!({ filter: 'userName eq "a@b.c"', count: 1 }, context);
    expect(result).toEqual({
      ok: true,
      output: { users: [{ id: "u1" }], totalResults: 1, itemsPerPage: 1, startIndex: 1 },
    });
    const api = new URL(calls[1]!.url);
    expect(api.origin).toBe("https://us2.api.concursolutions.com");
    expect(api.pathname).toBe("/profile/identity/v4/Users");
    expect(api.searchParams.get("filter")).toBe('userName eq "a@b.c"');
    expect(api.searchParams.get("count")).toBe("1");
  });

  it("requires the owner login for one report and filters entries by report", async () => {
    const calls = stubConcur(() => Response.json({ Items: [{ ID: "E1" }] }));
    expect(await executors["sap_concur.get_expense_report"]!({ reportId: "R1", user: "ALL" }, context)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    const ok = await executors["sap_concur.list_expense_entries"]!({ reportId: "R1", user: "a@b.c" }, context);
    expect(ok).toEqual({ ok: true, output: { entries: [{ ID: "E1" }] } });
    const url = new URL(calls.at(-1)!.url);
    expect(url.pathname).toBe("/api/v3.0/expense/entries");
    expect(url.searchParams.get("reportID")).toBe("R1");
    expect(url.searchParams.get("user")).toBe("a@b.c");
  });

  it("restricts query_resource to plain relative paths", async () => {
    stubConcur(() => Response.json({ ok: 1 }));
    expect(await executors["sap_concur.query_resource"]!({ path: "/travelrequest/v4/requests" }, context)).toEqual({
      ok: true,
      output: { data: { ok: 1 } },
    });
    for (const path of ["/api/../x", "/api/x?y=1", "/api//x"]) {
      expect(await executors["sap_concur.query_resource"]!({ path }, context)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });
});

describe("SAP Concur errors", () => {
  it("maps API 403 to authorization_failed with a scope hint", async () => {
    stubConcur(() => Response.json({ Message: "Forbidden" }, { status: 403 }));
    const result = await executors["sap_concur.get_user"]!({ userId: "abc" }, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("scopes") },
    });
  });

  it("maps a rejected refresh token to authorization_failed asking for a new token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error_description: "invalid_grant" }, { status: 400 })),
    );
    const result = await executors["sap_concur.get_user"]!({ userId: "abc" }, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("new company refresh token") },
    });
  });
});

describe("SAP Concur credential validation", () => {
  it("refreshes, probes Users and builds the profile, flagging rotation", async () => {
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(input.toString());
      return input.toString().includes("/oauth2/v0/token")
        ? tokenResponse({ refresh_token: "refresh-2" })
        : Response.json({ Resources: [] });
    };
    const result = await credentialValidators.customCredential!({ values }, { fetcher });
    expect(result).toMatchObject({
      profile: { accountId: "us2.api.concursolutions.com+client-1" },
      metadata: { apiHost: "https://eu2.api.concursolutions.com", refreshTokenRotated: true },
    });
    expect(calls[1]).toBe("https://eu2.api.concursolutions.com/profile/identity/v4/Users?count=1");
  });

  it("turns a rejected refresh token into a 400 connect-form error", async () => {
    await expect(
      credentialValidators.customCredential!(
        { values },
        { fetcher: async () => Response.json({ error_description: "invalid_grant" }, { status: 400 }) },
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("new company refresh token") });
  });
});
