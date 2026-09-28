import { getRandomValues } from 'expo-crypto';

/**
 * Hermes has no Web Crypto, so `globalThis.crypto` is undefined — and
 * @drawer/shared's uuidv7 reads randomness from it. Back it with expo-crypto's
 * native CSPRNG. Imported first thing in app/_layout.tsx so it's in place
 * before any capture runs.
 */
const g = globalThis as { crypto?: Partial<Crypto> };
g.crypto ??= {};
g.crypto.getRandomValues ??= getRandomValues as Crypto['getRandomValues'];
