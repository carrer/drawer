import { File, Paths } from 'expo-file-system';
import type { CapturedArtifact } from './capture.ts';

/**
 * Phase 0 persistence: a JSON file.
 *
 * Deliberately dumb. Phase 2 replaces this with expo-sqlite, which is what the
 * gallery needs for filtering and paging — but the Phase 0 gate only has to
 * prove captures survive an app restart, and a flat file proves that without
 * committing to a schema we're about to design properly.
 */

const STORE = () => new File(Paths.document, 'captures.json');

export function loadCaptures(): CapturedArtifact[] {
  const file = STORE();
  if (!file.exists) return [];
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    return Array.isArray(parsed) ? (parsed as CapturedArtifact[]) : [];
  } catch (err) {
    console.warn('[drawer] captures.json unreadable, starting fresh', err);
    return [];
  }
}

export function saveCaptures(items: CapturedArtifact[]): void {
  const file = STORE();
  if (!file.exists) file.create();
  file.write(JSON.stringify(items, null, 2));
}

/** Wipe everything — captures and the blobs they point at. Phase 0 debug affordance. */
export function clearAll(items: CapturedArtifact[]): void {
  for (const item of items) {
    if (!item.localUri) continue;
    try {
      const blob = new File(item.localUri);
      if (blob.exists) blob.delete();
    } catch (err) {
      console.warn('[drawer] could not delete blob', item.localUri, err);
    }
  }
  const file = STORE();
  if (file.exists) file.delete();
}
