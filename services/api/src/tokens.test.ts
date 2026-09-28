import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateDeviceToken,
  generateEnrollCode,
  hashSecret,
  normalizeEnrollCode,
  parseBearer,
} from './tokens.ts';

test('enroll codes are grouped Crockford base32 and unique', () => {
  const codes = new Set(Array.from({ length: 1000 }, generateEnrollCode));
  assert.equal(codes.size, 1000);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
});

test('a code survives being typed sloppily', () => {
  const code = generateEnrollCode();
  const sloppy = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
  assert.equal(normalizeEnrollCode(sloppy), normalizeEnrollCode(code));
  assert.equal(normalizeEnrollCode('oIl0-abcd'), '0110ABCD');
});

test('device tokens are prefixed and high-entropy', () => {
  const t = generateDeviceToken();
  assert.match(t, /^drw_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, generateDeviceToken());
});

test('hashSecret is sha256', () => {
  assert.equal(
    hashSecret('abc').toString('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('parseBearer accepts only a well-formed bearer header', () => {
  assert.equal(parseBearer('Bearer drw_abc'), 'drw_abc');
  assert.equal(parseBearer('bearer   drw_abc '), 'drw_abc');
  assert.equal(parseBearer(undefined), null);
  assert.equal(parseBearer('Basic Zm9vOmJhcg=='), null);
  assert.equal(parseBearer('Bearer a b'), null);
  assert.equal(parseBearer('Bearer '), null);
});
