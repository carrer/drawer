import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalItem } from '../db/repo.ts';
import { MAX_QR_TEXT_BYTES, qrSource } from './qrSource.ts';

const base: LocalItem = {
  id: '01926f3e-7a2b-7c00-8000-000000000000',
  kind: 'image',
  title: null,
  note: null,
  sha256: 'a'.repeat(64),
  byteSize: 10,
  mimeType: 'image/png',
  width: null,
  height: null,
  url: null,
  linkTitle: null,
  linkDescription: null,
  linkSiteName: null,
  body: null,
  extractedText: null,
  sourceApp: null,
  tags: [],
  categoryIds: [],
  capturedAt: '2026-09-29T10:00:00.000Z',
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  deletedAt: null,
  rev: null,
  syncState: 'synced',
  localPath: '/tmp/x.png',
  uploadError: null,
};
const item = (patch: Partial<LocalItem>): LocalItem => ({ ...base, ...patch });

test('links and short notes go straight into the code', () => {
  assert.deepEqual(qrSource(item({ kind: 'link', url: 'https://example.com', syncState: 'local' })), {
    type: 'direct',
    text: 'https://example.com',
    hint: 'Scan to open the link',
  });
  const note = qrSource(item({ kind: 'text', body: 'milk, eggs', syncState: 'local' }));
  assert.equal(note.type, 'direct');
});

test('notes that would make an unscannable code are refused, by UTF-8 bytes not characters', () => {
  assert.equal(qrSource(item({ kind: 'text', body: 'a'.repeat(MAX_QR_TEXT_BYTES) })).type, 'direct');
  assert.equal(qrSource(item({ kind: 'text', body: 'é'.repeat(MAX_QR_TEXT_BYTES / 2 + 1) })).type, 'unavailable');
  assert.equal(qrSource(item({ kind: 'text', body: '  ' })).type, 'unavailable');
});

test('files need the server, and only once their original has synced', () => {
  assert.deepEqual(qrSource(item({})), { type: 'server' });
  for (const syncState of ['local', 'uploading', 'error'] as const) {
    assert.equal(qrSource(item({ syncState })).type, 'unavailable', syncState);
  }
  assert.equal(qrSource(item({ sha256: null })).type, 'unavailable');
});
