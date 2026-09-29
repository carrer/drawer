import assert from 'node:assert/strict';
import { test } from 'node:test';
import QRCode from 'qrcode';
import { qrPath } from './qrPath.ts';

/** Paint the path back onto a grid, to compare against the encoder's modules. */
function paint(d: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) grid[Number(y)]![Number(x) + i] = true;
  }
  return grid;
}

test('a short payload is a version-1 code with a 4-module quiet zone', () => {
  const { size, d } = qrPath('hi');
  assert.equal(size, 21 + 8);
  // Top-left finder pattern: a solid 7-module run on its first row, inset by the quiet zone.
  assert.ok(d.startsWith('M4 4h7v1h-7z'), d.slice(0, 40));
});

test('the path paints exactly the encoder’s dark modules, and nothing in the quiet zone', () => {
  const text = 'https://drawer.example.ts.net/s/AbCdEfGhIjKlMnOpQrStUv';
  const { size, d } = qrPath(text);
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const grid = paint(d, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= 4 && y >= 4 && x < size - 4 && y < size - 4;
      const want = inside ? Boolean(modules.get(y - 4, x - 4)) : false;
      assert.equal(grid[y]![x], want, `module ${x},${y}`);
    }
  }
});

test('long text drops to error-correction L to stay scannable', () => {
  const text = 'x'.repeat(600);
  assert.equal(qrPath(text).size, QRCode.create(text, { errorCorrectionLevel: 'L' }).modules.size + 8);
});
