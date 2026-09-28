/**
 * Item kinds and the rules for deciding which one a shared artifact is.
 *
 * Shared between the app (which classifies at capture time, offline) and the
 * API (which re-validates). Keep it dependency-free and deterministic.
 */

export const ITEM_KINDS = ['image', 'video', 'audio', 'document', 'link', 'text'] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Map a MIME type to a kind.
 *
 * Android senders lie about MIME constantly — `application/octet-stream` for a
 * JPEG is routine — so the caller should sniff magic bytes first and use this
 * as the second opinion, not the first.
 */
export function kindFromMime(mime: string | null | undefined): ItemKind {
  const m = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'text/plain') return 'text';
  return 'document';
}

/** Magic-byte signatures, checked before trusting any declared MIME type. */
const MAGIC: ReadonlyArray<{ mime: string; offset: number; bytes: readonly number[] }> = [
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  // RIFF....WEBP — the 4 size bytes at offset 4 are skipped by the two-part check below.
  { mime: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  // ISO base media (mp4/mov/heic): 'ftyp' at offset 4. Brand at offset 8 disambiguates.
  { mime: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/**
 * Sniff a MIME type from the first bytes of a file. Returns null when nothing
 * matches, in which case fall back to the declared type or the extension.
 */
export function sniffMime(head: Uint8Array): string | null {
  for (const sig of MAGIC) {
    const end = sig.offset + sig.bytes.length;
    if (head.length < end) continue;
    if (sig.bytes.every((b, i) => head[sig.offset + i] === b)) {
      if (sig.mime === 'image/webp') {
        // RIFF is a container; confirm the WEBP fourcc at offset 8.
        const webp = [0x57, 0x45, 0x42, 0x50];
        if (head.length < 12 || !webp.every((b, i) => head[8 + i] === b)) continue;
        return 'image/webp';
      }
      if (sig.mime === 'video/mp4') {
        // 'ftyp' brand at offset 8: heic/heif/mif1 are stills, not video.
        const brand = String.fromCharCode(...Array.from(head.slice(8, 12)));
        if (/^(heic|heix|hevc|heim|heis|hevm|mif1|msf1|avif)$/.test(brand)) return 'image/heic';
        if (brand === 'qt  ') return 'video/quicktime';
        return 'video/mp4';
      }
      return sig.mime;
    }
  }
  return null;
}

/** Cheap, allocation-free URL test for deciding text-vs-link on a plain-text share. */
export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Classify a plain-text share. Many apps share "Some caption https://…" — we
 * treat that as a link with the remainder kept as the note, because the link is
 * almost always the thing you meant to save.
 */
export function classifyText(text: string): { kind: 'link'; url: string; note: string } | { kind: 'text'; body: string } {
  const trimmed = text.trim();
  if (looksLikeUrl(trimmed)) return { kind: 'link', url: trimmed, note: '' };

  const match = trimmed.match(/https?:\/\/\S+/);
  if (match?.[0] && looksLikeUrl(match[0])) {
    const note = (trimmed.slice(0, match.index) + trimmed.slice((match.index ?? 0) + match[0].length)).trim();
    return { kind: 'link', url: match[0], note };
  }
  return { kind: 'text', body: trimmed };
}
