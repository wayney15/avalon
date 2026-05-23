import type { AuthenticatedUserClaims } from "../../../packages/shared/src";

const JWT_HEADER = { alg: "HS256", typ: "JWT" } as const;
const TEXT_ENCODER = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const normalized = `${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", TEXT_ENCODER.encode(secret) as BufferSource, { hash: "SHA-256", name: "HMAC" }, false, [
    "sign",
    "verify"
  ]);
}

function base64UrlJson(value: unknown): string {
  return toBase64Url(TEXT_ENCODER.encode(JSON.stringify(value)));
}

export interface JwtOptions {
  issuer: string;
  secret: string;
  ttlSeconds?: number;
}

export interface JwtSubject {
  sub: string;
  username?: string;
  displayName?: string;
}

export async function signJwt(subject: JwtSubject, options: JwtOptions): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: AuthenticatedUserClaims = {
    ...subject,
    exp: issuedAt + (options.ttlSeconds ?? 60 * 60 * 24 * 7),
    iat: issuedAt,
    iss: options.issuer,
    sub: subject.sub
  };

  const signingInput = `${base64UrlJson(JWT_HEADER)}.${base64UrlJson(claims)}`;
  const key = await importSigningKey(options.secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(signingInput) as BufferSource));

  return `${signingInput}.${toBase64Url(signature)}`;
}

export async function verifyJwt(token: string, options: JwtOptions): Promise<AuthenticatedUserClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  try {
    const header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerPart))) as { alg?: string; typ?: string };
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return null;
    }

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadPart))) as Partial<AuthenticatedUserClaims>;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.iss !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    if (payload.iss !== options.issuer) {
      return null;
    }

    const signingInput = `${headerPart}.${payloadPart}`;
    const key = await importSigningKey(options.secret);
    const signature = fromBase64Url(signaturePart);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature as BufferSource,
      TEXT_ENCODER.encode(signingInput) as BufferSource
    );

    if (!valid) {
      return null;
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload as AuthenticatedUserClaims;
  } catch {
    return null;
  }
}
