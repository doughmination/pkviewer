import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe base64 with no padding. */
export function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

/** A cryptographically random opaque token. 32 bytes by default. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/**
 * Hash used for anything stored at rest that is presented as a bearer value.
 * Session cookies are stored hashed so a database read does not yield usable
 * sessions.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Raw(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison. Both sides are hex/base64 text of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Signs a short-lived payload carried in a cookie (the OAuth state and PKCE
 * verifier). The cookie is already __Host- and httpOnly; the signature means a
 * forged value cannot be accepted even if one were somehow set.
 */
export function sign(secret: string, payload: string): string {
  return base64url(createHmac("sha256", secret).update(payload, "utf8").digest());
}

export function signedValue(secret: string, payload: string): string {
  return `${base64url(Buffer.from(payload, "utf8"))}.${sign(secret, payload)}`;
}

export function verifySignedValue(secret: string, value: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!safeEqual(sign(secret, payload), signature)) return null;
  return payload;
}

/**
 * PKCE pair. The verifier stays with us (in the signed cookie); only the
 * challenge goes to Discord, so an intercepted authorization code cannot be
 * exchanged by anyone else.
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48)); // 64 chars, within the 43-128 range
  const challenge = base64url(sha256Raw(verifier));
  return { verifier, challenge };
}

/** Hashes request metadata for session records. We never store raw IPs. */
export function hashMeta(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  return createHmac("sha256", secret).update(value, "utf8").digest("hex").slice(0, 32);
}
