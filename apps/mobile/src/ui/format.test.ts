import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemDescriptor, itemTitle, normalizeTag, savedAgo } from './format.ts';

const base = { title: null, linkTitle: null, linkSiteName: null, url: null, body: null, mimeType: null, byteSize: null };

test('titles prefer what a person would call the item', () => {
  assert.equal(itemTitle({ ...base, kind: 'link', url: 'https://www.uxdesign.cc/x' }), 'uxdesign.cc');
  assert.equal(itemTitle({ ...base, kind: 'link', url: 'https://a.b/x', linkTitle: 'Empty states' }), 'Empty states');
  assert.equal(itemTitle({ ...base, kind: 'text', body: '  Buy film\nand a lens cap' }), 'Buy film');
  assert.equal(itemTitle({ ...base, kind: 'image' }), 'Image');
});

test('descriptors say where it came from or what it is', () => {
  assert.equal(itemDescriptor({ ...base, kind: 'link', url: 'https://www.uxdesign.cc/x' }), 'uxdesign.cc');
  assert.equal(
    itemDescriptor({ ...base, kind: 'document', title: 'Flight.pdf', mimeType: 'application/pdf', byteSize: 2048 }),
    'PDF · 2.0 KB',
  );
  assert.equal(itemDescriptor({ ...base, kind: 'image', byteSize: 99 }), 'Image');
});

test('savedAgo counts calendar days', () => {
  const now = new Date(2026, 8, 30, 9).getTime();
  assert.equal(savedAgo(new Date(2026, 8, 30, 1).toISOString(), now), 'saved today');
  assert.equal(savedAgo(new Date(2026, 8, 29, 23).toISOString(), now), 'saved yesterday');
  assert.equal(savedAgo(new Date(2026, 8, 26, 12).toISOString(), now), 'saved 4 days ago');
});

test('normalizeTag makes tags easy to type and match', () => {
  assert.equal(normalizeTag('  #Road  Trip '), 'road-trip');
  assert.equal(normalizeTag('##food'), 'food');
  assert.equal(normalizeTag('   #  '), '');
});
