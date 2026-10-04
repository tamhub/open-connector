import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";
import { normalizeOracleCloudIdentityHost, quoteScimString } from "./runtime.ts";

const instanceId = `idcs-${"ab12".repeat(8)}`;
const host = `${instanceId}.identity.oraclecloud.com`;

const values = { serviceInstance: instanceId, clientId: "cid", clientSecret: "s3cret$" };

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

function stubFetch(respond: (url: string, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (input.toString().endsWith("/oauth2/v1/token")) return Response.json({ access_token: "tok-1" });
      return respond(input.toString(), init);
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

describe("host normalisation", () => {
  it("maps an instance id and accepts domain URLs", () => {
    expect(normalizeOracleCloudIdentityHost(instanceId)).toBe(host);
    expect(normalizeOracleCloudIdentityHost(` https://${host}/ui/v1/myconsole `)).toBe(host);
    expect(normalizeOracleCloudIdentityHost("IDCS-X.identity.oraclecloud.com")).toBe("idcs-x.identity.oraclecloud.com");
  });

  it("rejects other hosts, schemes, ports and malformed ids", () => {
    for (const bad of [
      "evil.example.com",
      "http://idcs-x.identity.oraclecloud.com",
      "idcs-x.identity.oraclecloud.com.evil.com",
      "https://idcs-x.identity.oraclecloud.com:8443",
      "https://user:pw@idcs-x.identity.oraclecloud.com",
      ".identity.oraclecloud.com",
      "idcs-123",
    ]) {
      expect(() => normalizeOracleCloudIdentityHost(bad), bad).toThrow();
    }
  });
});

describe("token exchange and requests", () => {
  it("exchanges a token with Basic auth and the default scope, then lists users with Bearer", async () => {
    const calls = stubFetch(() =>
      Response.json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: 3,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: [{ id: "u1" }, { id: "u2" }],
      }),
    );
    const result = await executors["oracle_cloud_identity.list_users"]!(
      { filter: 'userName sw "a"', attributes: "id", count: 2 },
      context,
    );
    expect(result).toEqual({
      ok: true,
      output: {
        resources: [{ id: "u1" }, { id: "u2" }],
        totalResults: 3,
        startIndex: 1,
        itemsPerPage: 2,
        nextStartIndex: 3,
      },
    });
    const token = calls[0]!;
    expect(token.url).toBe(`https://${host}/oauth2/v1/token`);
    expect(token.init?.method).toBe("POST");
    const tokenHeaders = new Headers(token.init?.headers);
    expect(tokenHeaders.get("authorization")).toBe(`Basic ${Buffer.from("cid:s3cret$").toString("base64")}`);
    expect(new URLSearchParams(token.init?.body as string).toString()).toBe(
      "grant_type=client_credentials&scope=urn%3Aopc%3Aidm%3A__myscopes__",
    );
    const url = new URL(calls[1]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${host}/admin/v1/Users`);
    expect(url.searchParams.get("filter")).toBe('userName sw "a"');
    expect(url.searchParams.get("count")).toBe("2");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer tok-1");
  });

  it("search_users escapes quotes and backslashes in the generated filter", async () => {
    const calls = stubFetch(() => Response.json({ totalResults: 0, Resources: [] }));
    const result = await executors["oracle_cloud_identity.search_users"]!({ query: 'o"b\\x' }, context);
    expect(result).toMatchObject({ ok: true, output: { resources: [], nextStartIndex: null } });
    const url = new URL(calls[1]!.url);
    const term = '"o\\"b\\\\x"';
    expect(quoteScimString('o"b\\x')).toBe(term);
    expect(url.searchParams.get("filter")).toBe(
      `userName co ${term} or displayName co ${term} or emails.value co ${term}`,
    );
    expect(url.searchParams.get("count")).toBe("25");
  });

  it("builds PATCH bodies with the scim content type", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const added = await executors["oracle_cloud_identity.add_user_to_group"]!({ groupId: "g1", userId: "u1" }, context);
    expect(added).toEqual({ ok: true, output: { groupId: "g1", userId: "u1" } });
    expect(calls[1]!.url).toBe(`https://${host}/admin/v1/Groups/g1`);
    expect(calls[1]!.init?.method).toBe("PATCH");
    expect(new Headers(calls[1]!.init?.headers).get("content-type")).toBe("application/scim+json");
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "add", path: "members", value: [{ value: "u1", type: "User" }] }],
    });

    await executors["oracle_cloud_identity.remove_user_from_group"]!({ groupId: "g1", userId: "u1" }, context);
    expect(JSON.parse(calls[3]!.init?.body as string).Operations).toEqual([
      { op: "remove", path: 'members[value eq "u1"]' },
    ]);
  });

  it("rejects ids that could break out of the path", async () => {
    stubFetch(() => Response.json({}));
    const result = await executors["oracle_cloud_identity.get_user"]!({ userId: "../Groups" }, context);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("maps a SCIM error to authorization_failed with the service detail", async () => {
    stubFetch(() =>
      Response.json(
        { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "403", detail: "Not allowed" },
        { status: 403 },
      ),
    );
    const result = await executors["oracle_cloud_identity.get_user"]!({ userId: "u1" }, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("Not allowed") },
    });
  });

  it("maps a token rejection at execute time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error_description: "invalid client" }, { status: 401 })),
    );
    const result = await executors["oracle_cloud_identity.list_users"]!({}, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: expect.stringContaining("invalid client") },
    });
  });
});

describe("credential validation", () => {
  it("returns a profile keyed by host and client id", async () => {
    const urls: string[] = [];
    const result = await credentialValidators.customCredential!(
      { values },
      {
        fetcher: async (url) => {
          urls.push(url.toString());
          return url.toString().endsWith("/oauth2/v1/token")
            ? Response.json({ access_token: "t" })
            : Response.json({ totalResults: 1, Resources: [{ id: "u" }] });
        },
      },
    );
    expect(result).toMatchObject({ profile: { accountId: `${host}+cid` } });
    expect(urls[1]).toBe(`https://${host}/admin/v1/Users?count=1&attributes=id`);
  });

  it("names the missing app role on a 403", async () => {
    await expect(
      credentialValidators.customCredential!(
        { values },
        {
          fetcher: async (url) =>
            url.toString().endsWith("/oauth2/v1/token")
              ? Response.json({ access_token: "t" })
              : Response.json({ detail: "forbidden" }, { status: 403 }),
        },
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("User Administrator") });
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
