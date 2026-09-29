import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so a code read off a terminal can't be mistyped as another. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A one-shot enrollment code, `XXXX-XXXX-XXXX-XXXX`: 80 random bits, typed into
 * the app once. Short-lived and single-use, so 80 bits is plenty.
 */
export function generateEnrollCode(): string {
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 15; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out.match(/.{4}/g)!.join('-');
}

/** Forgive what people do when typing a code: case, dashes, spaces, and Crockford's look-alikes. */
export function normalizeEnrollCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/** Opaque bearer token for one device. Only its hash is stored. */
export function generateDeviceToken(): string {
  return `drw_${randomBytes(32).toString('base64url')}`;
}

/** Tokens and codes are high-entropy, so a plain SHA-256 is the right hash — no salt or KDF needed. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function parseBearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

/**
 * Share token for a QR code: 128 random bits, base64url (22 chars). It is
 * single-use and lives 30 seconds, so 128 bits is overkill — and a short token
 * keeps the QR code coarse enough to scan off a screen at arm's length.
 */
export function generateShareToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Cheap shape check, so garbage from the internet never reaches the database. */
export function isShareToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(s);
}
