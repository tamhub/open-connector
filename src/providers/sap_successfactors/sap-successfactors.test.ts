import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";
import { normalizeSuccessFactorsApiServer } from "./runtime.ts";
import { buildSignedSamlAssertion, parseSamlPrivateKey } from "./saml.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const bareBody = pkcs8Pem.replace(/-----[A-Z ]+-----/gu, "").replace(/\s+/gu, "");

const basicValues = {
  apiServer: "api4.successfactors.com",
  companyId: "ACME",
  username: "apiuser",
  password: "p@ss:word",
};
const samlValues = {
  apiServer: "https://api4.successfactors.com/some/path/",
  companyId: "ACME",
  clientId: "client-key",
  userId: "sfapi",
  privateKey: bareBody,
};

function credential(values: Record<string, string>): ResolvedCredential {
  return {
    authType: "custom_credential",
    values,
    profile: { accountId: "x", displayName: "x", grantedScopes: [] },
    metadata: {},
  };
}

const context = (values: Record<string, string>): ExecutionContext => ({
  getCredential: async () => credential(values),
});

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
  vi.unstubAllGlobals();
});

describe("SuccessFactors API server normalisation", () => {
  it("accepts documented SAP domains with or without https and drops paths", () => {
    expect(normalizeSuccessFactorsApiServer("api4.successfactors.com")).toBe("https://api4.successfactors.com");
    expect(normalizeSuccessFactorsApiServer("https://api55preview.sapsf.eu/odata/v2/")).toBe(
      "https://api55preview.sapsf.eu",
    );
    expect(normalizeSuccessFactorsApiServer("apisalesdemo8.successfactors.com")).toBe(
      "https://apisalesdemo8.successfactors.com",
    );
  });

  it("rejects http, other domains, lookalikes, ports and private targets", () => {
    expect(() => normalizeSuccessFactorsApiServer("http://api4.successfactors.com")).toThrow("must use https");
    expect(() => normalizeSuccessFactorsApiServer("api4.example.com")).toThrow("SuccessFactors API server");
    expect(() => normalizeSuccessFactorsApiServer("api4.successfactors.com.evil.net")).toThrow("SuccessFactors");
    expect(() => normalizeSuccessFactorsApiServer("evilsuccessfactors.com")).toThrow("SuccessFactors");
    expect(() => normalizeSuccessFactorsApiServer("api4.successfactors.com:8443")).toThrow("port");
    expect(() => normalizeSuccessFactorsApiServer("https://u:p@api4.successfactors.com")).toThrow("credentials");
    expect(() => normalizeSuccessFactorsApiServer("169.254.169.254")).toThrow();
  });
});

describe("SAML bearer assertion", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");
  const assertion = buildSignedSamlAssertion({
    clientId: "client&key",
    userId: "sf<api>",
    tokenUrl: "https://api4.successfactors.com/oauth/token",
    privateKey,
    now,
    id: "_abc",
  });

  it("carries the expected subject, audience, recipient and api_key attribute", () => {
    expect(assertion.xml).toContain("<saml2:Issuer>www.successfactors.com</saml2:Issuer>");
    expect(assertion.xml).toContain(
      '<saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">sf&lt;api&gt;</saml2:NameID>',
    );
    expect(assertion.xml).toContain('Recipient="https://api4.successfactors.com/oauth/token"');
    expect(assertion.xml).toContain('NotBefore="2026-10-05T11:59:00Z" NotOnOrAfter="2026-10-05T12:10:00Z"');
    expect(assertion.xml).toContain("<saml2:Audience>www.successfactors.com</saml2:Audience>");
    expect(assertion.xml).toContain(
      '<saml2:Attribute Name="api_key"><saml2:AttributeValue>client&amp;key</saml2:AttributeValue>',
    );
  });

  it("signs SignedInfo with RSA-SHA256, verifiable with the public key", () => {
    const signedInfo = /<ds:SignedInfo>(.*?)<\/ds:SignedInfo>/su.exec(assertion.xml)![1]!;
    const signatureValue = /<ds:SignatureValue>(.*?)<\/ds:SignatureValue>/su.exec(assertion.xml)![1]!;
    // Exclusive c14n of SignedInfo adds the namespace declaration it inherits from Signature.
    const canonical = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}</ds:SignedInfo>`;
    const verifier = createVerify("RSA-SHA256").update(canonical, "utf8");
    expect(verifier.verify(publicKey, signatureValue, "base64")).toBe(true);
    expect(signedInfo).toContain("rsa-sha256");

    const tampered = createVerify("RSA-SHA256").update(canonical.replace("#_abc", "#_xyz"), "utf8");
    expect(tampered.verify(publicKey, signatureValue, "base64")).toBe(false);
  });

  it("computes the digest over the assertion without the Signature element", () => {
    const digest = /<ds:DigestValue>(.*?)<\/ds:DigestValue>/su.exec(assertion.xml)![1]!;
    const withoutSignature = assertion.xml.replace(/<ds:Signature\b.*?<\/ds:Signature>/su, "");
    expect(withoutSignature).toBe(assertion.unsignedXml);
    expect(createHash("sha256").update(withoutSignature, "utf8").digest("base64")).toBe(digest);
    expect(withoutSignature).not.toContain("Signature");
  });
});

describe("SAML private key parsing", () => {
  it("accepts PKCS#8 PEM, PKCS#1 PEM, escaped newlines and the bare base64 body", () => {
    for (const value of [pkcs8Pem, pkcs1Pem, pkcs8Pem.trim().replaceAll("\n", "\\n"), bareBody]) {
      expect(parseSamlPrivateKey(value).asymmetricKeyType).toBe("rsa");
    }
  });

  it("rejects garbage and non-RSA keys", () => {
    expect(() => parseSamlPrivateKey("not a key!")).toThrow("privateKey");
    expect(() => parseSamlPrivateKey("AAAA")).toThrow("privateKey");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() => parseSamlPrivateKey(ec as string)).toThrow("RSA");
  });
});

describe("SuccessFactors actions", () => {
  it("uses Basic auth as username@companyId and shapes a list response", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        "https://api4.successfactors.com/odata/v2/EmpJob?$filter=userId%20eq%20%27jsmith%27&$select=jobTitle&$top=5&$skip=10&$inlinecount=allpages&$format=json",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("apiuser@ACME:p@ss:word").toString("base64")}`);
      return Response.json({
        d: {
          results: [{ jobTitle: "Engineer" }],
          __count: "42",
          __next: "https://api4.successfactors.com/odata/v2/EmpJob?$skiptoken=15&$top=5",
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_successfactors.list_job_info"]!(
      { filter: "userId eq 'jsmith'", select: "jobTitle", top: 5, skip: 10, includeCount: true },
      context(basicValues),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        records: [{ jobTitle: "Engineer" }],
        totalCount: 42,
        nextLink: "/odata/v2/EmpJob?$skiptoken=15&$top=5",
      },
    });
  });

  it("exchanges a signed SAML assertion for a bearer token, then reads a user by key", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(url);
      if (url === "https://api4.successfactors.com/oauth/token") {
        expect(init?.method).toBe("POST");
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("company_id")).toBe("ACME");
        expect(form.get("client_id")).toBe("client-key");
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:saml2-bearer");
        const xml = Buffer.from(form.get("assertion")!, "base64").toString("utf8");
        expect(xml).toContain('<saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">sfapi<');
        expect(xml).toContain("<ds:SignatureValue>");
        return Response.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok-1");
      return Response.json({ d: { userId: "o'brien", __metadata: { uri: "x" } } });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["sap_successfactors.get_user"]!({ userId: "o'brien" }, context(samlValues));

    expect(calls[1]).toBe("https://api4.successfactors.com/odata/v2/User('o''brien')?$format=json");
    expect(result).toEqual({ ok: true, output: { user: { userId: "o'brien", __metadata: { uri: "x" } } } });
  });

  it("expands personalInfoNav and employmentNav by default for list_employees", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toContain("/odata/v2/PerPerson?$expand=personalInfoNav%2CemploymentNav&$top=50");
      return Response.json({ d: { results: [] } });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await executors["sap_successfactors.list_employees"]!({}, context(basicValues));
    expect(result).toEqual({ ok: true, output: { records: [] } });
  });

  it("only follows nextLink paths under /odata/v2 on the configured host", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe("https://api4.successfactors.com/odata/v2/User?$skiptoken=9");
      return Response.json({ d: { results: [{ userId: "a" }] } });
    });
    vi.stubGlobal("fetch", fetch);
    const ok = await executors["sap_successfactors.fetch_next_page"]!(
      { nextLink: "https://other.example.com/odata/v2/User?$skiptoken=9" },
      context(basicValues),
    );
    expect(ok).toEqual({ ok: true, output: { records: [{ userId: "a" }] } });

    const bad = await executors["sap_successfactors.fetch_next_page"]!(
      { nextLink: "/etc/passwd" },
      context(basicValues),
    );
    expect(bad.ok).toBe(false);
  });

  it("maps SuccessFactors error bodies and a 401 to authorization_failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "COE_PROPERTY_NOT_FOUND", message: { lang: "en-US", value: "Property 'x' not found" } } },
          { status: 400 },
        ),
      ),
    );
    const badRequest = await executors["sap_successfactors.list_users"]!({ select: "x" }, context(basicValues));
    expect(badRequest).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Property 'x' not found" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const unauthorized = await executors["sap_successfactors.list_users"]!({}, context(basicValues));
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "authorization_failed" } });
  });

  it("requires exactly one complete credential set", async () => {
    const result = await executors["sap_successfactors.list_users"]!(
      {},
      context({ apiServer: "api4.successfactors.com", companyId: "ACME", clientId: "k", userId: "u" }),
    );
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("Provide either") } });
  });
});

describe("SuccessFactors credential validator", () => {
  it("probes User with $top=1 and builds the profile for Basic and surfaces token failures for SAML", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe("https://api4.successfactors.com/odata/v2/User?$top=1&$select=userId&$format=json");
      return Response.json({ d: { results: [{ userId: "x" }] } });
    });
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const options = { fetcher: globalThis.fetch, signal } as Parameters<
      NonNullable<typeof credentialValidators.customCredential>
    >[1];
    const result = await credentialValidators.customCredential!({ values: basicValues }, options);
    expect(result).toMatchObject({
      profile: { accountId: "api4.successfactors.com+ACME+apiuser" },
      metadata: { authMode: "basic" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_client", error_description: "bad client" }, { status: 401 })),
    );
    const failing = { ...options, fetcher: globalThis.fetch } as typeof options;
    await expect(credentialValidators.customCredential!({ values: samlValues }, failing)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("bad client"),
    });
  });
});
