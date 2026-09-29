import type { LocalItem } from '../db/repo.ts';

/**
 * Past this, a note's QR code gets too dense to scan off a phone screen at
 * arm's length (≈ version 20, 97 modules a side at error-correction L).
 */
export const MAX_QR_TEXT_BYTES = 800;

/**
 * What "Share as QR" encodes for an item.
 *
 * - `direct`: the content itself goes in the code — a link's URL (already
 *   public, so no expiry to enforce) or a short note. Works offline.
 * - `server`: files are too big for a QR code, so the code is a 30-second,
 *   single-use link minted by the API — which needs the original uploaded.
 * - `unavailable`: `reason` is shown to the person as-is.
 */
export type QrSource =
  | { type: 'direct'; text: string; hint: string }
  | { type: 'server' }
  | { type: 'unavailable'; reason: string };

export function qrSource(item: LocalItem): QrSource {
  if (item.kind === 'link') {
    return item.url
      ? { type: 'direct', text: item.url, hint: 'Scan to open the link' }
      : { type: 'unavailable', reason: 'This link has no URL to share.' };
  }
  if (item.kind === 'text') {
    const body = item.body ?? '';
    if (!body.trim()) return { type: 'unavailable', reason: 'This note is empty.' };
    if (new TextEncoder().encode(body).length > MAX_QR_TEXT_BYTES) {
      return { type: 'unavailable', reason: 'This note is too long to fit in a QR code. Use Share instead.' };
    }
    return { type: 'direct', text: body, hint: 'Scan to read the note' };
  }
  // A file: the recipient downloads the original from your drawer.
  if (item.syncState !== 'synced' || !item.sha256) {
    return {
      type: 'unavailable',
      reason: 'This file hasn’t reached your drawer yet. Once it has synced, it can be shared as a QR code.',
    };
  }
  return { type: 'server' };
}
