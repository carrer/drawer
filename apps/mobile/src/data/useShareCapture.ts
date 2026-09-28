import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { ingestShareIntent } from '../capture.ts';
import { insertItems } from '../db/repo.ts';
import { useWrite } from './store.tsx';

export type CaptureNotice = { tone: 'ok' | 'error'; text: string } | null;

/**
 * Drains incoming shares into the local database (Inbox) and reports what
 * happened. Mounted once, by the gallery, which is where every share lands.
 */
export function useShareCapture() {
  const write = useWrite();
  const { isReady, hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const [notice, setNotice] = useState<CaptureNotice>(null);
  const ingesting = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || ingesting.current) return;
    ingesting.current = true;

    ingestShareIntent(shareIntent)
      .then((captured) => {
        if (captured.length === 0) {
          setNotice({ tone: 'error', text: 'That share contained nothing Drawer could store.' });
          return;
        }
        write((db) =>
          insertItems(
            db,
            captured.map((c) => ({
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
            })),
          ),
        );
        const dupes = captured.filter((c) => c.duplicate).length;
        const saved = captured.length === 1 ? 'Saved to Inbox' : `Saved ${captured.length} to Inbox`;
        setNotice({
          tone: 'ok',
          text: dupes > 0 ? `${saved} · ${dupes === 1 ? 'file was' : `${dupes} files were`} already stored` : saved,
        });
      })
      .catch((err: unknown) => setNotice({ tone: 'error', text: String(err) }))
      .finally(() => {
        ingesting.current = false;
        resetShareIntent();
      });
  }, [hasShareIntent, shareIntent, resetShareIntent, write]);

  const shown: CaptureNotice = error ? { tone: 'error', text: error } : notice;
  return { isReady, notice: shown, dismiss: () => setNotice(null) };
}
