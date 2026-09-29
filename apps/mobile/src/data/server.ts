import { ErrorResponseSchema, ShareResponseSchema, type ShareResponse } from '@drawer/shared';

/**
 * The phone's connection to your drawer: the API origin and this device's
 * token. Enrollment (Phase 3) writes both; until then every call here fails
 * with a message saying so rather than pretending to work.
 */
export const SERVER_URL_KEY = 'drawer.server.url';
export const DEVICE_TOKEN_KEY = 'drawer.device.token';

type Server = { url: string; token: string };

/**
 * Loaded on first use, like expo-sharing in actions.ts: a static import of a
 * native module the installed dev client lacks takes down the whole route tree.
 */
async function getServer(): Promise<Server | null> {
  let store: typeof import('expo-secure-store');
  try {
    store = await import('expo-secure-store');
  } catch {
    throw new Error('This build is missing expo-secure-store. Rebuild the dev client (make android).');
  }
  const [url, token] = await Promise.all([store.getItemAsync(SERVER_URL_KEY), store.getItemAsync(DEVICE_TOKEN_KEY)]);
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

async function call(method: string, path: string): Promise<unknown> {
  const server = await getServer();
  if (!server) throw new Error('This phone isn’t connected to your drawer yet.');
  let res: Response;
  try {
    res = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${server.token}` } });
  } catch {
    throw new Error('Couldn’t reach your drawer. Are you on your tailnet?');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(body);
    throw new Error(err.success ? err.data.message : `Your drawer answered ${res.status}.`);
  }
  return body;
}

/** A fresh single-use, short-lived download link for one item's original. */
export async function mintShare(itemId: string): Promise<ShareResponse> {
  return ShareResponseSchema.parse(await call('POST', `/v1/items/${itemId}/share`));
}
