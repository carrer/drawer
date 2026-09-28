import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyText, kindFromMime, looksLikeUrl, sniffMime } from './kinds.ts';

test('kindFromMime maps families and strips parameters', () => {
  assert.equal(kindFromMime('image/jpeg'), 'image');
  assert.equal(kindFromMime('text/plain; charset=utf-8'), 'text');
  assert.equal(kindFromMime('video/mp4'), 'video');
  assert.equal(kindFromMime('application/pdf'), 'document');
  assert.equal(kindFromMime(null), 'document');
});

test('sniffMime beats a lying declared type', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(sniffMime(jpeg), 'image/jpeg');

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sniffMime(png), 'image/png');

  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  assert.equal(sniffMime(pdf), 'application/pdf');
});

test('sniffMime separates HEIC stills from mp4 video', () => {
  const ftyp = (brand: string) =>
    new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...Array.from(brand, (c) => c.charCodeAt(0))]);
  assert.equal(sniffMime(ftyp('heic')), 'image/heic');
  assert.equal(sniffMime(ftyp('isom')), 'video/mp4');
});

test('sniffMime requires the WEBP fourcc, not just RIFF', () => {
  const riffWave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(sniffMime(riffWave), null);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffMime(webp), 'image/webp');
});

test('sniffMime returns null on short or unknown input', () => {
  assert.equal(sniffMime(new Uint8Array([0xff])), null);
  assert.equal(sniffMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test('looksLikeUrl rejects non-http schemes and anything with whitespace', () => {
  assert.equal(looksLikeUrl('https://example.com/a'), true);
  assert.equal(looksLikeUrl('javascript:alert(1)'), false);
  assert.equal(looksLikeUrl('file:///etc/passwd'), false);
  assert.equal(looksLikeUrl('hello https://example.com'), false);
});

test('classifyText pulls the link out of a shared caption', () => {
  assert.deepEqual(classifyText('https://example.com/x'), { kind: 'link', url: 'https://example.com/x', note: '' });
  assert.deepEqual(classifyText('look at this https://example.com/x'), {
    kind: 'link',
    url: 'https://example.com/x',
    note: 'look at this',
  });
  assert.deepEqual(classifyText('just a thought'), { kind: 'text', body: 'just a thought' });
});
