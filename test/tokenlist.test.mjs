import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTokenList, searchTokens } from '../scripts/tokenlist.mjs';

// Clearly fake EXAMPLE addresses (Cyprus-1 shaped: 0x00 + 38 hex).
const A1 = '0x00' + '11'.repeat(19);
const A2 = '0x00' + '22'.repeat(19);
const A3 = '0x00' + '33'.repeat(19);

const good = () => ({
  name: 'Example List',
  timestamp: '2026-01-01T00:00:00.000Z',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    { chainId: 9, address: A1, symbol: 'EXA', name: 'Example Alpha', decimals: 18, logoURI: 'https://example.com/a.png' },
    { chainId: 9, address: A2, symbol: 'EXB', name: 'Example Beta', decimals: 6 },
  ],
});

const withToken = (patch) => {
  const l = good();
  l.tokens[0] = { ...l.tokens[0], ...patch };
  return l;
};
const errs = (l) => validateTokenList(l).errors.join('\n');

test('a valid list passes with no errors', () => {
  const r = validateTokenList(good());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('Orchard testnet chainId 15000 is accepted', () => {
  assert.equal(validateTokenList(withToken({ chainId: 15000 })).valid, true);
});

test('missing name is an error', () => {
  const l = good(); delete l.name;
  assert.match(errs(l), /name/);
});

test('bad version shape is an error', () => {
  const l = good(); l.version = '1.0.0';
  assert.match(errs(l), /version/);
});

test('bad timestamp is an error', () => {
  const l = good(); l.timestamp = 'yesterday-ish';
  assert.match(errs(l), /timestamp/);
});

test('tokens must be an array', () => {
  const l = good(); l.tokens = {};
  assert.match(errs(l), /tokens/);
});

test('non-object list is rejected without throwing', () => {
  assert.equal(validateTokenList(null).valid, false);
  assert.equal(validateTokenList('x').valid, false);
});

test('unsupported chainId is an error', () => {
  const r = validateTokenList(withToken({ chainId: 1 }));
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /chainId/);
});

test('malformed address is an error', () => {
  assert.match(errs(withToken({ address: '0x123' })), /address/);
  assert.match(errs(withToken({ address: '00' + '11'.repeat(19) + 'ab' })), /address/);
  assert.match(errs(withToken({ address: '0x00' + 'zz'.repeat(19) })), /address/);
});

test('non Cyprus-1 zone prefix is a warning, not an error', () => {
  const r = validateTokenList(withToken({ address: '0x10' + '11'.repeat(19) }));
  assert.equal(r.valid, true);
  assert.match(r.warnings.join('\n'), /zone|Cyprus-1/i);
});

test('Qi-shaped address (0x00 then a byte >= 0x80) is flagged', () => {
  const r = validateTokenList(withToken({ address: '0x0080' + 'a1'.repeat(18) }));
  assert.match(r.errors.concat(r.warnings).join('\n'), /Qi/);
});

test('duplicate address on the same chain is an error, case-insensitive', () => {
  const l = good();
  l.tokens[1].address = A1.toUpperCase().replace('0X', '0x');
  assert.match(errs(l), /duplicate/i);
});

test('same address on different chains is allowed', () => {
  const l = good();
  l.tokens[1].address = A1;
  l.tokens[1].chainId = 15000;
  assert.equal(validateTokenList(l).valid, true);
});

test('decimals outside 0..36 or non-integer are errors', () => {
  assert.match(errs(withToken({ decimals: 37 })), /decimals/);
  assert.match(errs(withToken({ decimals: -1 })), /decimals/);
  assert.match(errs(withToken({ decimals: 1.5 })), /decimals/);
  assert.equal(validateTokenList(withToken({ decimals: 0 })).valid, true);
  assert.equal(validateTokenList(withToken({ decimals: 36 })).valid, true);
});

test('missing symbol or name on a token is an error', () => {
  assert.match(errs(withToken({ symbol: '' })), /symbol/);
  assert.match(errs(withToken({ name: undefined })), /name/);
});

test('insecure or odd logoURI is a warning, non-string is an error', () => {
  const w = validateTokenList(withToken({ logoURI: 'http://example.com/a.png' }));
  assert.equal(w.valid, true);
  assert.match(w.warnings.join('\n'), /logoURI/);
  assert.match(errs(withToken({ logoURI: 42 })), /logoURI/);
});

test('missing logoURI is fine (UI falls back to initials)', () => {
  assert.equal(validateTokenList(good()).valid, true);
});

const list = () => ({
  ...good(),
  tokens: [
    { chainId: 9, address: A1, symbol: 'ABC', name: 'Zeta Coin', decimals: 18 },
    { chainId: 9, address: A2, symbol: 'ABCD', name: 'Plain', decimals: 18 },
    { chainId: 9, address: A3, symbol: 'XYZ', name: 'Has abc inside', decimals: 18 },
    { chainId: 9, address: '0xabc0' + 'd4'.repeat(18), symbol: 'QQQ', name: 'Other', decimals: 18 },
  ],
});

test('searchTokens ranks exact symbol > prefix symbol > name contains > address prefix', () => {
  const res = searchTokens(list(), 'abc');
  assert.deepEqual(res.map((t) => t.symbol), ['ABC', 'ABCD', 'XYZ', 'QQQ']);
});

test('searchTokens is case-insensitive and trims', () => {
  assert.equal(searchTokens(list(), '  AbC ')[0].symbol, 'ABC');
});

test('searchTokens matches an address prefix', () => {
  const res = searchTokens(list(), A3.slice(0, 10));
  assert.equal(res[0].symbol, 'XYZ');
});

test('searchTokens with empty query returns all tokens in original order', () => {
  assert.equal(searchTokens(list(), '').length, 4);
  assert.equal(searchTokens(list(), '')[0].symbol, 'ABC');
});

test('searchTokens returns nothing for no match and accepts a bare token array and limit', () => {
  assert.deepEqual(searchTokens(list(), 'nomatch'), []);
  assert.equal(searchTokens(list().tokens, 'abc').length, 4);
  assert.equal(searchTokens(list(), 'abc', { limit: 2 }).length, 2);
});

test('searchTokens can filter by chainId', () => {
  const l = list();
  l.tokens[0].chainId = 15000;
  const res = searchTokens(l, 'abc', { chainId: 9 });
  assert.equal(res.find((t) => t.symbol === 'ABC'), undefined);
});
