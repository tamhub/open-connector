import type { KeyObject } from "node:crypto";

import { createHash, createPrivateKey, createSign, randomUUID } from "node:crypto";
import { providerInputError } from "../provider-runtime.ts";

/**
 * SAML 2.0 bearer assertion builder for the SuccessFactors OAuth token endpoint.
 *
 * The assertion is generated here, so it is emitted directly in exclusive
 * canonical form instead of going through an XML canonicalizer: no whitespace
 * between elements, no self-closing tags, one namespace declaration on the
 * element that first uses it, attributes in canonical order, and escaped text.
 * That makes the text we digest and sign identical to what a verifier computes.
 */

const assertionNamespace = "urn:oasis:names:tc:SAML:2.0:assertion";
const signatureNamespace = "http://www.w3.org/2000/09/xmldsig#";
const c14nAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
const signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const digestAlgorithm = "http://www.w3.org/2001/04/xmlenc#sha256";
const envelopedAlgorithm = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const nameIdUnspecified = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
const bearerMethod = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const authnContextUnspecified = "urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified";

/** Issuer and audience that SuccessFactors expects on assertions for its OAuth endpoint. */
export const successFactorsSamlIssuer = "www.successfactors.com";

/** Assertion lifetime; the token endpoint only needs it to be valid at exchange time. */
const assertionLifetimeMs = 10 * 60 * 1000;
/** Allow for a client clock that runs slightly ahead of the SAP server. */
const clockSkewMs = 60 * 1000;

export interface SamlAssertionInput {
  clientId: string;
  userId: string;
  tokenUrl: string;
  privateKey: KeyObject;
  now?: Date;
  /** Assertion ID; must be a valid XML NCName. Defaults to a random one. */
  id?: string;
}

export interface SamlAssertion {
  /** The signed assertion XML, before base64 encoding. */
  xml: string;
  /** The same assertion without its Signature element, which is what the digest covers. */
  unsignedXml: string;
  id: string;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#xD;");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\r", "&#xD;");
}

function instant(date: Date): string {
  // xs:dateTime in UTC without fractional seconds.
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/**
 * Build the signed bearer assertion. The Signature element sits after the
 * Issuer, as the SAML schema requires.
 */
export function buildSignedSamlAssertion(input: SamlAssertionInput): SamlAssertion {
  const now = input.now ?? new Date();
  const id = input.id ?? `_${randomUUID()}`;
  const issued = instant(now);
  const notBefore = instant(new Date(now.getTime() - clockSkewMs));
  const notOnOrAfter = instant(new Date(now.getTime() + assertionLifetimeMs));

  const assertionOpen = `<saml2:Assertion xmlns:saml2="${assertionNamespace}" ID="${escapeAttribute(id)}" IssueInstant="${issued}" Version="2.0">`;
  const issuer = `<saml2:Issuer>${successFactorsSamlIssuer}</saml2:Issuer>`;
  const body =
    `<saml2:Subject><saml2:NameID Format="${nameIdUnspecified}">${escapeText(input.userId)}</saml2:NameID>` +
    `<saml2:SubjectConfirmation Method="${bearerMethod}"><saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${escapeAttribute(input.tokenUrl)}"></saml2:SubjectConfirmationData></saml2:SubjectConfirmation></saml2:Subject>` +
    `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml2:AudienceRestriction><saml2:Audience>${successFactorsSamlIssuer}</saml2:Audience></saml2:AudienceRestriction></saml2:Conditions>` +
    `<saml2:AuthnStatement AuthnInstant="${issued}"><saml2:AuthnContext><saml2:AuthnContextClassRef>${authnContextUnspecified}</saml2:AuthnContextClassRef></saml2:AuthnContext></saml2:AuthnStatement>` +
    `<saml2:AttributeStatement><saml2:Attribute Name="api_key"><saml2:AttributeValue>${escapeText(input.clientId)}</saml2:AttributeValue></saml2:Attribute></saml2:AttributeStatement>`;
  const close = "</saml2:Assertion>";

  // Enveloped-signature transform: the digest covers the assertion without the Signature element.
  const unsignedXml = `${assertionOpen}${issuer}${body}${close}`;
  const digest = createHash("sha256").update(unsignedXml, "utf8").digest("base64");

  const signedInfoContent =
    `<ds:CanonicalizationMethod Algorithm="${c14nAlgorithm}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${signatureAlgorithm}"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${escapeAttribute(id)}"><ds:Transforms>` +
    `<ds:Transform Algorithm="${envelopedAlgorithm}"></ds:Transform>` +
    `<ds:Transform Algorithm="${c14nAlgorithm}"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${digestAlgorithm}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference>`;
  // Canonical SignedInfo declares the ds namespace itself; inside the document it inherits it from Signature.
  const canonicalSignedInfo = `<ds:SignedInfo xmlns:ds="${signatureNamespace}">${signedInfoContent}</ds:SignedInfo>`;
  const signatureValue = createSign("RSA-SHA256").update(canonicalSignedInfo, "utf8").sign(input.privateKey, "base64");

  const signature =
    `<ds:Signature xmlns:ds="${signatureNamespace}"><ds:SignedInfo>${signedInfoContent}</ds:SignedInfo>` +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue></ds:Signature>`;

  return { xml: `${assertionOpen}${issuer}${signature}${body}${close}`, unsignedXml, id };
}

/**
 * Accept the private key as a PEM (PKCS#8 or PKCS#1), a PEM with escaped `\n`
 * sequences, or the bare base64 body that SuccessFactors displays.
 */
export function parseSamlPrivateKey(value: string): KeyObject {
  const text = value.trim().replaceAll(String.raw`\n`, "\n");
  const candidates: string[] = [];
  if (text.includes("-----BEGIN")) {
    candidates.push(text);
  } else {
    const body = text.replace(/\s+/gu, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) {
      throw providerInputError("privateKey must be a PEM private key or its base64 body.");
    }
    const wrapped = body.match(/.{1,64}/gu)!.join("\n");
    candidates.push(
      `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`,
      `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----`,
    );
  }
  for (const pem of candidates) {
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      continue;
    }
    if (key.asymmetricKeyType !== "rsa") throw providerInputError("privateKey must be an RSA private key.");
    return key;
  }
  throw providerInputError("privateKey could not be read as an unencrypted RSA private key (PKCS#8 or PKCS#1).");
}
