import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeServerUrl } from './server.ts';

test('normalizeServerUrl defaults to https and drops trailing slashes', () => {
  assert.equal(normalizeServerUrl(' drawer.tail1234.ts.net/ '), 'https://drawer.tail1234.ts.net');
  assert.equal(normalizeServerUrl('https://drawer.tail1234.ts.net'), 'https://drawer.tail1234.ts.net');
  assert.equal(normalizeServerUrl('http://192.168.1.120:8080//'), 'http://192.168.1.120:8080');
  assert.equal(normalizeServerUrl('HTTP://Example.COM'), 'http://example.com');
});

test('normalizeServerUrl rejects nothing and nonsense', () => {
  assert.throws(() => normalizeServerUrl('   '), /Enter your drawer/);
  assert.throws(() => normalizeServerUrl('http://'), /isn’t an address/);
});
