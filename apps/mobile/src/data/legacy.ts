import { INBOX_CATEGORY_ID } from '@drawer/shared';
import { File, Paths } from 'expo-file-system';
import type { CapturedArtifact } from '../capture.ts';
import { insertItems } from '../db/repo.ts';
import type { SqlDb } from '../db/sql.ts';

/**
 * Phase 0 kept captures in documents/captures.json. Move them into SQLite once,
 * into Inbox, then rename the file so this never runs twice. Renamed rather than
 * deleted: it's the only copy of those rows, and insertItems is idempotent on id
 * anyway, so restoring the file and relaunching is a safe re-import.
 */
export function importLegacyCaptures(db: SqlDb): void {
  const file = new File(Paths.document, 'captures.json');
  if (!file.exists) return;
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    const captures = Array.isArray(parsed) ? (parsed as CapturedArtifact[]) : [];
    insertItems(
      db,
      captures.map((c) => ({
        id: c.id,
        kind: c.kind,
        title: c.title,
        note: c.note,
        url: c.url,
        body: c.body,
        sha256: c.sha256,
        byteSize: c.byteSize,
        mimeType: c.mimeType,
        localPath: c.localUri,
        capturedAt: c.capturedAt,
        categoryIds: [INBOX_CATEGORY_ID],
      })),
    );
    file.rename('captures.imported.json');
  } catch (err) {
    // Leave the file where it is so the next launch retries.
    console.warn('[drawer] could not import captures.json', err);
  }
}
