import { classifyText, kindFromMime, sniffMime, uuidv7, type ItemKind } from '@drawer/shared';
import { Directory, File, Paths } from 'expo-file-system';
import type { ShareIntent, ShareIntentFile } from 'expo-share-intent';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Capture: turn whatever the OS share sheet handed us into durable local rows.
 *
 * Everything here runs before any network call. The share sheet gives us about
 * a second of the user's attention and Android revokes the content:// grant the
 * moment the activity goes away, so the bytes have to land on our own disk now
 * and sync can happen whenever.
 */

export type CapturedArtifact = {
  id: string;
  kind: ItemKind;
  title: string | null;
  note: string | null;
  url: string | null;
  body: string | null;
  /** Lowercase hex sha256 — also the storage key on the server. Null for link/text. */
  sha256: string | null;
  byteSize: number | null;
  mimeType: string | null;
  localUri: string | null;
  /** True when these exact bytes were already in the drawer. */
  duplicate: boolean;
  capturedAt: string;
};

const blobsRoot = () => new Directory(Paths.document, 'blobs');

/** blobs/<ab>/<cd>/<hex> — mirrors the server layout so keys are identical on both sides. */
function blobFile(hex: string): File {
  const dir = new Directory(blobsRoot(), hex.slice(0, 2), hex.slice(2, 4));
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, hex);
}

/**
 * Hash and sniff in a single streaming pass.
 *
 * Deliberately never materialises the file: a 4K video would blow the heap if we
 * read it whole, and we need the first 16 bytes anyway to second-guess the
 * declared MIME type, so both come out of the same walk.
 */
async function digestAndSniff(file: File): Promise<{ hex: string; byteSize: number; sniffed: string | null }> {
  const hasher = sha256.create();
  const reader = file.readableStream().getReader();
  let byteSize = 0;
  let head: Uint8Array | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (head === null) head = value.slice(0, 16);
      hasher.update(value);
      byteSize += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    hex: bytesToHex(hasher.digest()),
    byteSize,
    sniffed: head ? sniffMime(head) : null,
  };
}

/**
 * Move a shared file into the content-addressed store.
 *
 * The magic-byte sniff wins over the declared type: Android senders label JPEGs
 * `application/octet-stream` routinely, and a wrong kind means the item renders
 * as a grey document card instead of a picture.
 */
async function ingestFile(f: ShareIntentFile, capturedAt: string): Promise<CapturedArtifact> {
  const source = new File(f.path);
  const { hex, byteSize, sniffed } = await digestAndSniff(source);
  const mimeType = sniffed ?? f.mimeType ?? 'application/octet-stream';

  const dest = blobFile(hex);
  const duplicate = dest.exists;
  if (duplicate) {
    source.delete(); // same bytes already stored; drop the share-sheet copy
  } else {
    source.move(dest);
  }

  return {
    id: uuidv7(),
    kind: kindFromMime(mimeType),
    title: f.fileName ?? null,
    note: null,
    url: null,
    body: null,
    sha256: hex,
    byteSize,
    mimeType,
    localUri: dest.uri,
    duplicate,
    capturedAt,
  };
}

/** A plain-text or URL share. No bytes, so nothing to hash or move. */
function ingestText(text: string, meta: ShareIntent['meta'], capturedAt: string): CapturedArtifact {
  const classified = classifyText(text);
  const base = {
    id: uuidv7(),
    title: meta?.title ?? null,
    sha256: null,
    byteSize: null,
    mimeType: null,
    localUri: null,
    duplicate: false,
    capturedAt,
  };

  return classified.kind === 'link'
    ? { ...base, kind: 'link', url: classified.url, note: classified.note || null, body: null }
    : { ...base, kind: 'text', url: null, note: null, body: classified.body };
}

/**
 * Drain one share intent. Returns everything captured — a multi-image share
 * produces one artifact per file.
 */
export async function ingestShareIntent(intent: ShareIntent): Promise<CapturedArtifact[]> {
  const capturedAt = new Date().toISOString();
  const out: CapturedArtifact[] = [];
  const failures: string[] = [];

  for (const f of intent.files ?? []) {
    try {
      out.push(await ingestFile(f, capturedAt));
    } catch (err) {
      console.warn('[drawer] failed to ingest file', f.path, err);
      failures.push(`${f.fileName ?? f.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Every file failed — surface why instead of the generic "nothing we could store".
  if (out.length === 0 && failures.length > 0) {
    throw new Error(failures.join('\n'));
  }

  // webUrl is the link the module already extracted; text is the raw payload.
  // Only take the text path when there were no files, otherwise a shared image
  // with a caption would produce a phantom second item.
  const text = intent.webUrl ?? intent.text;
  if (out.length === 0 && text) {
    out.push(ingestText(text, intent.meta, capturedAt));
  }

  return out;
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
