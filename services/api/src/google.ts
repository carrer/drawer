import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError } from './errors.ts';
import type { GoogleIdentity } from './users.ts';

/** Google's signing keys. jose caches them and refetches on an unknown `kid`. */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Turns a Google ID token into a verified identity plus the nonce it carries, or throws a 401. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity & { nonce: string | null }>;

/**
 * Verify a Google ID token offline: signature against Google's published keys,
 * issuer, audience (our Web client ID — the `serverClientId` the app signs in
 * with), and expiry. Only outbound HTTPS to Google is needed, so this works on a
 * tailnet-only box. `keys` is injectable so tests can sign their own tokens.
 */
export function createGoogleVerifier(
  clientId: string,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)),
): GoogleVerifier {
  return async (idToken) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch (err) {
      // Key-fetch failures are our problem, not the caller's: let them 500.
      if (err instanceof errors.JOSEError && !(err instanceof errors.JWKSTimeout)) {
        throw new HttpError(401, 'invalid_token', 'Google sign-in could not be verified');
      }
      throw err;
    }

    const { sub, email, email_verified: verified, name, nonce } = payload;
    if (typeof sub !== 'string' || typeof email !== 'string') {
      throw new HttpError(401, 'invalid_token', 'Google sign-in did not include an email');
    }
    return {
      sub,
      email,
      // Google sends a boolean; some older tokens carried the string "true".
      emailVerified: verified === true || verified === 'true',
      name: typeof name === 'string' ? name : null,
      nonce: typeof nonce === 'string' ? nonce : null,
    };
  };
}
