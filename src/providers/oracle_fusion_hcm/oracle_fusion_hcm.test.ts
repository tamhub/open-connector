import { describe, expect, it, vi } from "vitest";
import { credentialValidators } from "./executors.ts";
import {
  createOracleFusionHcmContext,
  extractOracleErrorMessage,
  normalizeOracleFusionHcmBaseUrl,
  normalizeResourcePath,
  oracleFusionHcmActionHandlers,
} from "./runtime.ts";

const values = { restServerUrl: "pod.fa.us2.oraclecloud.com", username: "hr.user", password: "pä:ss" };
const expectedAuth = `Basic ${Buffer.from("hr.user:pä:ss", "utf8").toString("base64")}`;

function context(fetchMock: ReturnType<typeof vi.fn>) {
  return createOracleFusionHcmContext(values, fetchMock as unknown as typeof fetch);
}

describe("host normalisation", () => {
  it("accepts a bare host, an https URL, and trims paths", () => {
    expect(normalizeOracleFusionHcmBaseUrl("pod.fa.us2.oraclecloud.com")).toBe("https://pod.fa.us2.oraclecloud.com");
    expect(normalizeOracleFusionHcmBaseUrl(" https://pod.fa.us2.oraclecloud.com/fscmUI/faces/x?y=1 ")).toBe(
      "https://pod.fa.us2.oraclecloud.com",
    );
  });

  it("rejects http, other schemes, credentials, and unsafe targets", () => {
    expect(() => normalizeOracleFusionHcmBaseUrl("http://pod.example.com")).toThrow("must use https");
    expect(() => normalizeOracleFusionHcmBaseUrl("ftp://pod.example.com")).toThrow("must use https");
    expect(() => normalizeOracleFusionHcmBaseUrl("https://user:pw@pod.example.com")).toThrow("credentials");
    expect(() => normalizeOracleFusionHcmBaseUrl("https://169.254.169.254")).toThrow();
    expect(() => normalizeOracleFusionHcmBaseUrl("localhost")).toThrow();
    expect(() => normalizeOracleFusionHcmBaseUrl("")).toThrow();
  });
});

describe("resource path validation", () => {
  it("normalizes relative paths", () => {
    expect(normalizeResourcePath("/publicWorkers/")).toBe("publicWorkers");
    expect(normalizeResourcePath("workers/abc/child/emails")).toBe("workers/abc/child/emails");
  });

  it.each([
    "../x",
    "a/../b",
    "a/%2e%2e/b",
    "https://evil.com/x",
    "//evil.com/x",
    "a?b=1",
    "a\\b",
    "a//b",
    "hcmRestApi/resources/x",
    "",
  ])("rejects %j", (path) => {
    expect(() => normalizeResourcePath(path)).toThrow();
  });
});

describe("list actions", () => {
  it("builds the request and shapes the page", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        items: [
          {
            PersonId: 1,
            PersonNumber: "100",
            links: [
              { rel: "self", href: "https://pod/hcmRestApi/resources/11.13.18.05/workers/00020000ABCD" },
              { rel: "child", href: "x" },
            ],
            names: [{ LastName: "Doe", links: [] }],
          },
        ],
        count: 1,
        hasMore: true,
        limit: 1,
        offset: 5,
        links: [],
      }),
    );

    const result = await oracleFusionHcmActionHandlers.list_workers(
      {
        q: "PersonNumber=100",
        limit: 1,
        offset: 5,
        fields: "PersonId,PersonNumber",
        expand: "names",
        totalResults: true,
      },
      context(fetchMock),
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "https://pod.fa.us2.oraclecloud.com/hcmRestApi/resources/11.13.18.05/workers",
    );
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      q: "PersonNumber=100",
      limit: "1",
      offset: "5",
      fields: "PersonId,PersonNumber",
      expand: "names",
      totalResults: "true",
    });
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(expectedAuth);
    expect(headers["rest-framework-version"]).toBe("4");
    expect(init!.method).toBe("GET");
    expect(result).toEqual({
      items: [{ uniqueId: "00020000ABCD", PersonId: 1, PersonNumber: "100", names: [{ LastName: "Doe" }] }],
      count: 1,
      hasMore: true,
      limit: 1,
      offset: 5,
      nextOffset: 6,
      totalResults: null,
    });
  });

  it("targets the documented resource per action", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => Response.json({ items: [], count: 0, hasMore: false }));
    await oracleFusionHcmActionHandlers.list_departments({}, context(fetchMock));
    await oracleFusionHcmActionHandlers.list_absences({ q: "personNumber=1" }, context(fetchMock));
    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname.split("/").pop());
    expect(paths).toEqual(["departmentsLov", "absences"]);
  });
});

describe("get_worker and query_resource", () => {
  it("encodes the worker key and strips links", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ PersonId: 1, links: [{ rel: "self" }] }),
    );
    const result = await oracleFusionHcmActionHandlers.get_worker(
      { workerId: "00AB", expand: "emails" },
      context(fetchMock),
    );
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/hcmRestApi/resources/11.13.18.05/workers/00AB");
    expect(url.searchParams.get("onlyData")).toBe("true");
    expect(url.searchParams.get("expand")).toBe("emails");
    expect(result).toEqual({ worker: { PersonId: 1 } });
    await expect(oracleFusionHcmActionHandlers.get_worker({ workerId: "a/b" }, context(fetchMock))).rejects.toThrow(
      "opaque",
    );
  });

  it("returns raw data from an arbitrary path with onlyData defaulting to true", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => Response.json({ items: [{ a: 1 }] }));
    const result = await oracleFusionHcmActionHandlers.query_resource(
      { path: "publicWorkers", limit: 2, orderBy: "PersonId:asc" },
      context(fetchMock),
    );
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/hcmRestApi/resources/11.13.18.05/publicWorkers");
    expect(url.searchParams.get("onlyData")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("PersonId:asc");
    expect(result).toEqual({ data: { items: [{ a: 1 }] } });
  });
});

describe("error mapping", () => {
  it("extracts messages from Oracle JSON and plain text", () => {
    expect(
      extractOracleErrorMessage(JSON.stringify({ title: "Bad Request", "o:errorDetails": [{ detail: "Bad q" }] })),
    ).toBe("Bad q");
    expect(extractOracleErrorMessage(JSON.stringify({ title: "Unauthorized" }))).toBe("Unauthorized");
    expect(extractOracleErrorMessage("Plain failure")).toBe("Plain failure");
    expect(extractOracleErrorMessage("<html></html>")).toBeUndefined();
  });

  it("keeps the upstream status on execute", async () => {
    const fetchMock = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(oracleFusionHcmActionHandlers.list_jobs({}, context(fetchMock))).rejects.toMatchObject({
      status: 403,
      message: "denied",
    });
  });

  it("maps a validate-phase 401 to a 400 field error", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(
      credentialValidators.customCredential!({ values }, { fetcher: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("credential validation", () => {
  it("calls a cheap workers query and returns host + username identity", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [{ PersonId: 1 }], count: 1, hasMore: true }),
    );
    // Bypass DNS resolution of the fake host while still exercising the injected fetcher.
    const result = await credentialValidators.customCredential!(
      { values },
      { fetcher: fetchMock as unknown as typeof fetch },
    );
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/hcmRestApi/resources/11.13.18.05/workers");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "1", onlyData: "true", fields: "PersonId" });
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(expectedAuth);
    expect(result).toMatchObject({
      profile: { accountId: "pod.fa.us2.oraclecloud.com:hr.user" },
    });
  });

  it("rejects a non-https host before any request", async () => {
    const fetchMock = vi.fn();
    await expect(
      credentialValidators.customCredential!(
        { values: { ...values, restServerUrl: "http://pod.example.com" } },
        { fetcher: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow("must use https");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
