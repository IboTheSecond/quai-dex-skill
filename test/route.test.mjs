import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netOut, bestRoute, evaluateSplit, minOut, gasCostOut } from '../scripts/route.mjs';

const E18 = 10n ** 18n;

// Constant-product pool quote function (no fee) used to build realistic split cases.
const pool = (reserveIn, reserveOut) => (amountIn) => ({
  amountOut: (amountIn * reserveOut) / (reserveIn + amountIn),
});

test('gasCostOut converts gas units x gas price into output-token units (BigInt exact)', () => {
  // 100k gas at 1 gwei = 1e14 wei; 1 QUAI (1e18 wei) is worth 3e18 output base units.
  assert.equal(gasCostOut(100_000n, 1_000_000_000n, 3n * E18), 300_000_000_000_000n);
});

test('netOut subtracts gas cost (in output units) from amountOut', () => {
  const q = { venue: 'a', amountOut: 5n * E18, gasUnits: 100_000n, hops: 1 };
  assert.equal(netOut(q, 1_000_000_000n, 3n * E18), 5n * E18 - 300_000_000_000_000n);
});

test('netOut accepts string amounts and may go negative on dust trades', () => {
  const q = { venue: 'a', amountOut: '100', gasUnits: '100000', hops: 1 };
  assert.equal(netOut(q, 1_000_000_000n, 3n * E18) < 0n, true);
});

test('bestRoute picks max net output, not max gross output', () => {
  const quotes = [
    { venue: 'big-gross', amountOut: 1_000_000_000_000_000_000n, gasUnits: 900_000n, hops: 3 },
    { venue: 'lean', amountOut: 999_000_000_000_000_000n, gasUnits: 100_000n, hops: 1 },
  ];
  // gas 1 gwei, 1 QUAI = 1 output token: big-gross pays 9e14 gas, lean pays 1e14.
  const res = bestRoute(quotes, { gasPriceWei: 1_000_000_000n, gasValueInOut: E18 });
  // gross diff = 1e15; gas diff = 8e14 -> big-gross still wins by 2e14.
  assert.equal(res.best.venue, 'big-gross');
  const res2 = bestRoute(quotes, { gasPriceWei: 5_000_000_000n, gasValueInOut: E18 });
  // gas diff = 4e15 > 1e15 gross diff -> lean wins.
  assert.equal(res2.best.venue, 'lean');
});

test('bestRoute ranks all valid quotes best first with net values', () => {
  const quotes = [
    { venue: 'a', amountOut: 100n, gasUnits: 0n, hops: 1 },
    { venue: 'b', amountOut: 300n, gasUnits: 0n, hops: 1 },
    { venue: 'c', amountOut: 200n, gasUnits: 0n, hops: 1 },
  ];
  const res = bestRoute(quotes, { gasPriceWei: 1n, gasValueInOut: E18 });
  assert.deepEqual(res.ranked.map((r) => r.quote.venue), ['b', 'c', 'a']);
  assert.equal(res.ranked[0].net, 300n);
});

test('bestRoute breaks net ties by fewer hops, then lower gas, then venue name', () => {
  const quotes = [
    { venue: 'z-three-hops', amountOut: 500n, gasUnits: 0n, hops: 3 },
    { venue: 'b-one-hop', amountOut: 500n, gasUnits: 0n, hops: 1 },
    { venue: 'a-one-hop', amountOut: 500n, gasUnits: 0n, hops: 1 },
  ];
  const res = bestRoute(quotes, { gasPriceWei: 1n, gasValueInOut: E18 });
  assert.equal(res.best.venue, 'a-one-hop');
  assert.deepEqual(res.ranked.map((r) => r.quote.venue), ['a-one-hop', 'b-one-hop', 'z-three-hops']);
});

test('bestRoute skips zero, missing and malformed quotes and returns best:null when none valid', () => {
  const opts = { gasPriceWei: 1n, gasValueInOut: E18 };
  const res = bestRoute([{ venue: 'dead', amountOut: 0n }, { venue: 'bad' }, null], opts);
  assert.equal(res.best, null);
  assert.equal(res.ranked.length, 0);
  assert.equal(res.skipped.length, 3);
  assert.equal(bestRoute([], opts).best, null);
});

test('bestRoute drops routes whose net is not positive', () => {
  const res = bestRoute(
    [{ venue: 'dust', amountOut: 10n, gasUnits: 100_000n, hops: 1 }],
    { gasPriceWei: 1_000_000_000n, gasValueInOut: E18 },
  );
  assert.equal(res.best, null);
});

test('evaluateSplit returns a split when two similar pools make a big trade cheaper to split', () => {
  const A = pool(1_000_000n, 1_000_000n);
  const B = pool(1_000_000n, 1_000_000n);
  const amountIn = 200_000n;
  const res = evaluateSplit(A, B, amountIn, 10, 1_000n);
  assert.ok(res, 'split expected');
  assert.equal(res.amountA + res.amountB, amountIn);
  assert.equal(res.amountA, 100_000n);
  assert.equal(res.total, 181_818n);
  assert.equal(res.bestSingle, 166_666n);
  assert.equal(res.gain, 181_818n - 166_666n - 1_000n);
});

test('evaluateSplit returns null when the gain does not cover the extra gas', () => {
  const A = pool(1_000_000n, 1_000_000n);
  const B = pool(1_000_000n, 1_000_000n);
  assert.equal(evaluateSplit(A, B, 200_000n, 10, 50_000n), null);
});

test('evaluateSplit returns null for a small trade where splitting adds nothing even with zero extra gas', () => {
  const A = pool(1_000_000n, 1_000_000n);
  const B = pool(1_000_000n, 1_000_000n);
  assert.equal(evaluateSplit(A, B, 1_000n, 10, 0n), null);
});

test('evaluateSplit sends more to the deeper pool when pools differ', () => {
  const deep = pool(10_000_000n, 10_000_000n);
  const shallow = pool(1_000_000n, 1_000_000n);
  const res = evaluateSplit(deep, shallow, 500_000n, 20, 0n);
  assert.ok(res);
  assert.ok(res.amountA > res.amountB);
  assert.equal(res.amountA + res.amountB, 500_000n);
});

test('evaluateSplit keeps amounts exact when amountIn is not divisible by steps', () => {
  const A = pool(1_000_000n, 1_000_000n);
  const B = pool(1_000_000n, 1_000_000n);
  const res = evaluateSplit(A, B, 200_001n, 10, 0n);
  assert.ok(res);
  assert.equal(res.amountA + res.amountB, 200_001n);
});

test('evaluateSplit accepts quote functions returning bare BigInt', () => {
  const A = (x) => (x * 1_000_000n) / (1_000_000n + x);
  const B = (x) => (x * 1_000_000n) / (1_000_000n + x);
  const res = evaluateSplit(A, B, 200_000n, 10, 0n);
  assert.ok(res);
  assert.equal(res.total, 181_818n);
});

test('minOut is exact BigInt math, floored', () => {
  assert.equal(minOut(1000n, 50), 995n);
  assert.equal(minOut(1n, 50), 0n);
  assert.equal(minOut(10_000n, 0), 10_000n);
  assert.equal(minOut(10_000n, 10_000), 0n);
  const big = 123456789012345678901234567890n;
  assert.equal(minOut(big, 100), (big * 9900n) / 10000n);
  assert.equal(typeof minOut(big, 100), 'bigint');
});

test('minOut accepts decimal-string amounts and rejects bad slippage', () => {
  assert.equal(minOut('2000', 250), 1950n);
  assert.throws(() => minOut(1000n, -1));
  assert.throws(() => minOut(1000n, 10_001));
  assert.throws(() => minOut(1000n, 0.5));
  assert.throws(() => minOut(-5n, 50));
});
