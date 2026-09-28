import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { uuidv7, uuidv7Time } from './id.ts';

test('uuidv7 has the right shape, version and variant', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuidv7 round-trips its timestamp, including past 2^32 ms', () => {
  for (const ms of [0, 1_700_000_000_000, 2 ** 32 + 12345, Date.now()]) {
    assert.equal(uuidv7Time(uuidv7(ms)).getTime(), ms, `failed for ${ms}`);
  }
});

test('uuidv7 sorts chronologically as a string', () => {
  const ids = [1000, 2000, 3000, 4000].map((ms) => uuidv7(ms));
  assert.deepEqual([...ids].sort(), ids);
});

test('uuidv7 is unique within the same millisecond', () => {
  const ids = new Set(Array.from({ length: 500 }, () => uuidv7(1234)));
  assert.equal(ids.size, 500);
});
