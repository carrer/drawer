import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentDisposition, downloadFilename, fixedWindowLimiter } from './share.ts';

const ID = '01926f3e-7a2b-7c00-8000-000000000000';

test('downloadFilename uses the title, adds the extension once, and falls back to the id', () => {
  assert.equal(downloadFilename('Beach day', ID, 'image/jpeg'), 'Beach day.jpg');
  assert.equal(downloadFilename('scan.PDF', ID, 'application/pdf'), 'scan.PDF');
  assert.equal(downloadFilename(null, ID, 'video/mp4'), 'drowa-01926f3e.mp4');
  assert.equal(downloadFilename('   ', ID, 'application/pdf; charset=binary'), 'drowa-01926f3e.pdf');
  assert.equal(downloadFilename('notes', ID, 'application/x-unknown'), 'notes');
});

test('downloadFilename strips path separators and control characters', () => {
  assert.equal(downloadFilename('../../etc/passwd', ID, 'text/plain'), '.. .. etc passwd.txt');
  assert.equal(downloadFilename('a\r\nb"c', ID, 'image/png'), 'a b c.png');
});

test('contentDisposition carries an ASCII fallback and the exact UTF-8 name', () => {
  assert.equal(
    contentDisposition('Café (1).jpg'),
    `attachment; filename="Caf_ (1).jpg"; filename*=UTF-8''Caf%C3%A9%20%281%29.jpg`,
  );
});

test('fixedWindowLimiter allows `limit` per window, then resets', () => {
  let now = 1_000;
  const allow = fixedWindowLimiter(2, 60_000, () => now);
  assert.deepEqual([allow(), allow(), allow()], [true, true, false]);
  now += 59_999;
  assert.equal(allow(), false);
  now += 1;
  assert.deepEqual([allow(), allow(), allow()], [true, true, false]);
});
