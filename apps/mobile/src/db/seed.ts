import { INBOX_CATEGORY_ID } from '@drawer/shared';
import { countItems, insertItems, type NewItem } from './repo.ts';
import type { SqlDb } from './sql.ts';

const MEMES = '00000000-0000-0000-0000-0000000000a2';
const READ_LATER = '00000000-0000-0000-0000-0000000000a3';
const REFERENCE = '00000000-0000-0000-0000-0000000000a4';

/** Fixed ids so seeding twice is a no-op (insert is idempotent on id). */
const seedId = (n: number) => `5eed0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * Sample rows for exercising the gallery with no server and no shares — every
 * kind, a spread of image aspect ratios for the masonry grid, and items in
 * several categories. Media rows have no local bytes, so they render the
 * placeholder tile: that path has to look right anyway, because synced items
 * whose originals were evicted (Phase 5) render the same way.
 *
 * Returns how many rows were actually added.
 */
export function seedSampleData(db: SqlDb): number {
  const before = countItems(db);
  const base = Date.now();
  const ago = (hours: number) => new Date(base - hours * 3_600_000).toISOString();

  const rows: NewItem[] = [
    { kind: 'image', title: 'Tall screenshot', mimeType: 'image/png', width: 1080, height: 2400, byteSize: 812_344, categoryIds: [MEMES] },
    { kind: 'link', url: 'https://www.sqlite.org/whentouse.html', linkTitle: 'Appropriate Uses For SQLite', linkSiteName: 'sqlite.org', categoryIds: [READ_LATER] },
    { kind: 'text', body: 'Pick up the film from the lab on Thursday. Ask whether they still do 120 push processing.', categoryIds: [INBOX_CATEGORY_ID] },
    { kind: 'image', title: 'Landscape photo', mimeType: 'image/jpeg', width: 4032, height: 3024, byteSize: 3_402_118, categoryIds: [INBOX_CATEGORY_ID] },
    { kind: 'document', title: 'lease-agreement.pdf', mimeType: 'application/pdf', byteSize: 1_204_551, categoryIds: [REFERENCE] },
    { kind: 'video', title: 'concert.mp4', mimeType: 'video/mp4', byteSize: 48_220_901, categoryIds: [INBOX_CATEGORY_ID] },
    { kind: 'image', title: 'Square meme', mimeType: 'image/webp', width: 1024, height: 1024, byteSize: 88_120, categoryIds: [MEMES, INBOX_CATEGORY_ID] },
    { kind: 'link', url: 'https://en.wikipedia.org/wiki/Content-addressable_storage', linkTitle: 'Content-addressable storage', linkSiteName: 'Wikipedia', categoryIds: [REFERENCE, READ_LATER] },
    { kind: 'audio', title: 'voice-memo.m4a', mimeType: 'audio/mp4', byteSize: 912_004, categoryIds: [INBOX_CATEGORY_ID] },
    { kind: 'text', body: '“The best way to have a good idea is to have a lot of ideas.”', note: 'for the talk intro', categoryIds: [] },
    { kind: 'image', title: 'Panorama', mimeType: 'image/jpeg', width: 6000, height: 1500, byteSize: 5_880_004, categoryIds: [] },
    { kind: 'link', url: 'https://example.com/a/very/long/path/that/should/truncate/nicely/in/the/tile', categoryIds: [INBOX_CATEGORY_ID] },
  ].map((r, n) => ({ ...r, id: seedId(n + 1), capturedAt: ago(n * 7 + 1) }) as NewItem);

  insertItems(db, rows);
  return countItems(db) - before;
}
