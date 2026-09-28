/**
 * UUIDv7 — a 48-bit millisecond timestamp followed by randomness.
 *
 * Generated on the device so capture works with no network, and so a retried
 * POST is an upsert rather than a duplicate. v7 rather than v4 because the ids
 * sort chronologically, which means the gallery's primary ordering and the
 * primary key agree and Postgres inserts stay append-ish instead of scattering
 * across the btree.
 */
export function uuidv7(now: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  const b = random(16);

  // 48-bit big-endian millisecond timestamp. Bit ops are 32-bit in JS, so the
  // high two bytes are derived by division rather than >>> 32.
  b[0] = Math.floor(now / 2 ** 40) & 0xff;
  b[1] = Math.floor(now / 2 ** 32) & 0xff;
  b[2] = (now >>> 24) & 0xff;
  b[3] = (now >>> 16) & 0xff;
  b[4] = (now >>> 8) & 0xff;
  b[5] = now & 0xff;

  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Recover the creation time from a v7 id — useful for debugging sync ordering. */
export function uuidv7Time(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}
