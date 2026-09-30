import {
  AuthConfigResponseSchema,
  EnrollResponseSchema,
  ErrorResponseSchema,
  NonceResponseSchema,
  ShareResponseSchema,
  WhoAmIResponseSchema,
  type ShareResponse,
} from '@drawer/shared';

/**
 * The phone's connection to your drawer: which box, which account, and this
 * device's token. Signing in writes all three; until then every call here fails
 * with a message saying so rather than pretending to work.
 */
export const SERVER_URL_KEY = 'drawer.server.url';
export const DEVICE_TOKEN_KEY = 'drawer.device.token';
export const ACCOUNT_EMAIL_KEY = 'drawer.account.email';

export type Account = { url: string; token: string; email: string | null };

/**
 * Forgive what people type for an address: no scheme means https (the tailnet
 * name has a real certificate), and trailing slashes go. A plain-http dev box
 * has to be typed with its http://.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.replace(/\/+$/, '')) throw new Error('Enter your drawer’s address.');
  // Scheme first: stripping slashes before this would turn "http://" into a hostname.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`“${trimmed}” isn’t an address.`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Native modules load on first use, like expo-sharing in actions.ts: a static
 * import of one the installed dev client lacks takes down the whole route tree.
 */
async function secureStore() {
  try {
    return await import('expo-secure-store');
  } catch {
    throw new Error('This build is missing expo-secure-store. Rebuild the dev client (make android).');
  }
}

async function googleSignIn() {
  try {
    return (await import('react-native-nitro-google-signin')).GoogleOneTapSignIn;
  } catch {
    throw new Error('This build is missing Google sign-in. Rebuild the dev client (make android).');
  }
}

export async function getAccount(): Promise<Account | null> {
  const store = await secureStore();
  const [url, token, email] = await Promise.all([
    store.getItemAsync(SERVER_URL_KEY),
    store.getItemAsync(DEVICE_TOKEN_KEY),
    store.getItemAsync(ACCOUNT_EMAIL_KEY),
  ]);
  return url && token ? { url, token, email } : null;
}

async function saveAccount(a: Account) {
  const store = await secureStore();
  await store.setItemAsync(SERVER_URL_KEY, a.url);
  await store.setItemAsync(DEVICE_TOKEN_KEY, a.token);
  if (a.email) await store.setItemAsync(ACCOUNT_EMAIL_KEY, a.email);
  else await store.deleteItemAsync(ACCOUNT_EMAIL_KEY);
}

async function forgetAccount() {
  const store = await secureStore();
  await Promise.all([SERVER_URL_KEY, DEVICE_TOKEN_KEY, ACCOUNT_EMAIL_KEY].map((k) => store.deleteItemAsync(k)));
}

async function request(url: string, method: string, path: string, opts: { token?: string; body?: object } = {}) {
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error('Couldn’t reach your drawer. Check the address, and that you’re on your tailnet.');
  }
  if (res.status === 204) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(body);
    throw new Error(err.success ? err.data.message : `Your drawer answered ${res.status}.`);
  }
  return body;
}

/** An authenticated call as the signed-in device. */
async function call(method: string, path: string): Promise<unknown> {
  const account = await getAccount();
  if (!account) throw new Error('This phone isn’t signed in to your drawer yet.');
  return request(account.url, method, path, { token: account.token });
}

/** Store a freshly issued device token, then ask the server whose it is. */
async function finishSignIn(url: string, token: string): Promise<Account> {
  const me = WhoAmIResponseSchema.parse(await request(url, 'GET', '/v1/auth/whoami', { token }));
  const account = { url, token, email: me.email };
  await saveAccount(account);
  return account;
}

/** Whether the box at `url` offers Google sign-in. Also proves the address works. */
export async function googleAvailable(url: string): Promise<boolean> {
  return AuthConfigResponseSchema.parse(await request(url, 'GET', '/v1/auth/config')).googleWebClientId !== null;
}

/**
 * Sign in with Google: nonce from the drawer → Google's account picker with
 * that nonce → trade the ID token for a device token. Null if the person
 * backed out of the picker.
 */
export async function signInWithGoogle(url: string, deviceName: string): Promise<Account | null> {
  const { googleWebClientId } = AuthConfigResponseSchema.parse(await request(url, 'GET', '/v1/auth/config'));
  if (!googleWebClientId) throw new Error('Google sign-in isn’t set up on this drawer. Use an enrollment code.');
  const { nonce } = NonceResponseSchema.parse(await request(url, 'POST', '/v1/auth/nonce'));

  const google = await googleSignIn();
  // Configured per attempt: the nonce is single-use, so each sign-in needs a new one.
  google.configure({ webClientId: googleWebClientId, nonce });
  const res = await google.presentExplicitSignIn();
  if (res.type !== 'success' || !res.data) return null;

  const { token } = EnrollResponseSchema.parse(
    await request(url, 'POST', '/v1/auth/google', { body: { idToken: res.data.idToken, deviceName } }),
  );
  return finishSignIn(url, token);
}

/** The fallback without Google: a one-shot code from `make enroll-code EMAIL=…`. */
export async function signInWithCode(url: string, code: string, deviceName: string): Promise<Account> {
  const { token } = EnrollResponseSchema.parse(
    await request(url, 'POST', '/v1/auth/enroll', { body: { code, deviceName } }),
  );
  return finishSignIn(url, token);
}

/**
 * Revoke this device's token on the drawer (best effort — offline, it stays
 * valid until `make revoke`), forget Google's session, and forget the account.
 * Wiping local data is the caller's job.
 */
export async function signOut(): Promise<{ revoked: boolean }> {
  let revoked = false;
  try {
    await call('POST', '/v1/auth/signout');
    revoked = true;
  } catch {
    // Unreachable or already revoked; either way the phone forgets the token.
  }
  await googleSignIn()
    .then((g) => g.signOut())
    .catch(() => {});
  await forgetAccount();
  return { revoked };
}

/** A fresh single-use, short-lived download link for one item's original. */
export async function mintShare(itemId: string): Promise<ShareResponse> {
  return ShareResponseSchema.parse(await call('POST', `/v1/items/${itemId}/share`));
}
