// Pure routing helpers for a DEX aggregator. BigInt only, zero dependencies.
//
// Units: every amount is an integer in base units (wei-like) of its own token.
//   gasPriceWei    - native-token wei per gas unit (read it from the chain, never hard-code).
//   gasValueInOut  - output-token base units that equal 1e18 wei (1 native token) of gas.
//                    Example: 1 native token is worth 3 output tokens with 18 decimals
//                    -> gasValueInOut = 3n * 10n ** 18n.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const WEI_PER_NATIVE = 10n ** 18n;

function toBig(value, name) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new TypeError(`${name} must be an integer (BigInt, safe integer or digit string)`);
}

/** Gas cost expressed in output-token base units. */
export function gasCostOut(gasUnits, gasPriceWei, gasValueInOut) {
  const g = toBig(gasUnits ?? 0n, 'gasUnits');
  return (g * toBig(gasPriceWei, 'gasPriceWei') * toBig(gasValueInOut, 'gasValueInOut')) / WEI_PER_NATIVE;
}

/** Output amount minus gas cost, both in output-token base units. May be negative. */
export function netOut(quote, gasPriceWei, gasValueInOut) {
  return toBig(quote.amountOut, 'amountOut') - gasCostOut(quote.gasUnits ?? 0n, gasPriceWei, gasValueInOut);
}

/**
 * Pick the quote with the highest net output.
 * quote = { venue, amountOut, gasUnits?, hops? }
 * Ties: fewer hops, then less gas, then venue name (deterministic).
 * Returns { best, ranked: [{ quote, net }], skipped: [{ quote, reason }] }.
 */
export function bestRoute(quotes, opts = {}) {
  const { gasPriceWei = 0n, gasValueInOut = 0n } = opts;
  const ranked = [];
  const skipped = [];
  for (const quote of quotes || []) {
    if (!quote || typeof quote !== 'object') { skipped.push({ quote, reason: 'not an object' }); continue; }
    let out;
    try { out = toBig(quote.amountOut, 'amountOut'); } catch { skipped.push({ quote, reason: 'missing or invalid amountOut' }); continue; }
    if (out <= 0n) { skipped.push({ quote, reason: 'amountOut <= 0' }); continue; }
    let net;
    try { net = netOut(quote, gasPriceWei, gasValueInOut); } catch { skipped.push({ quote, reason: 'invalid gas fields' }); continue; }
    if (net <= 0n) { skipped.push({ quote, reason: 'net output <= 0 after gas' }); continue; }
    ranked.push({ quote, net });
  }
  ranked.sort((a, b) => {
    if (a.net !== b.net) return a.net > b.net ? -1 : 1;
    const ha = a.quote.hops ?? 1;
    const hb = b.quote.hops ?? 1;
    if (ha !== hb) return ha - hb;
    const ga = toBig(a.quote.gasUnits ?? 0n, 'gasUnits');
    const gb = toBig(b.quote.gasUnits ?? 0n, 'gasUnits');
    if (ga !== gb) return ga < gb ? -1 : 1;
    return String(a.quote.venue).localeCompare(String(b.quote.venue));
  });
  return { best: ranked.length ? ranked[0].quote : null, ranked, skipped };
}

function outOf(q) {
  return toBig(q !== null && typeof q === 'object' ? q.amountOut : q, 'amountOut');
}

/**
 * Grid-search a two-venue split of amountIn.
 * quoteFnA / quoteFnB: (amountIn: bigint) => bigint | { amountOut }.
 * extraGas: extra cost of using two venues instead of one, ALREADY in output-token units.
 * Returns null unless splitting beats the best single venue by more than extraGas.
 * Otherwise { amountA, amountB, outA, outB, total, bestSingle, bestSingleVenue, gain }.
 */
export function evaluateSplit(quoteFnA, quoteFnB, amountIn, steps = 10, extraGas = 0n) {
  const total = toBig(amountIn, 'amountIn');
  const n = BigInt(Math.max(2, Math.floor(steps)));
  const extra = toBig(extraGas, 'extraGas');
  if (total <= 0n) return null;

  const allA = outOf(quoteFnA(total));
  const allB = outOf(quoteFnB(total));
  const bestSingle = allA >= allB ? allA : allB;
  const bestSingleVenue = allA >= allB ? 'A' : 'B';

  let best = null;
  for (let i = 1n; i < n; i++) {
    const amountA = (total * i) / n;
    const amountB = total - amountA;
    if (amountA <= 0n || amountB <= 0n) continue;
    const outA = outOf(quoteFnA(amountA));
    const outB = outOf(quoteFnB(amountB));
    const sum = outA + outB;
    if (!best || sum > best.total) best = { amountA, amountB, outA, outB, total: sum };
  }
  if (!best) return null;
  const gain = best.total - bestSingle - extra;
  if (gain <= 0n) return null;
  return { ...best, bestSingle, bestSingleVenue, gain };
}

/** Minimum acceptable output: floor(amountOut * (10000 - slippageBps) / 10000). */
export function minOut(amountOut, slippageBps) {
  const out = toBig(amountOut, 'amountOut');
  if (out < 0n) throw new RangeError('amountOut must be >= 0');
  let b;
  try { b = toBig(slippageBps, 'slippageBps'); } catch { throw new RangeError('slippageBps must be an integer 0..10000'); }
  if (b < 0n || b > 10000n) throw new RangeError('slippageBps must be an integer 0..10000');
  return (out * (10000n - b)) / 10000n;
}

// ---- CLI demo: node scripts/route.mjs examples/quotes.json -------------------------------
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

async function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error('usage: node scripts/route.mjs <quotes.json>');
    return 2;
  }
  const data = JSON.parse(await readFile(file, 'utf8'));
  const res = bestRoute(data.quotes, { gasPriceWei: data.gasPriceWei, gasValueInOut: data.gasValueInOut });
  const slippageBps = data.slippageBps ?? 50;
  const out = {
    tokenIn: data.tokenIn,
    tokenOut: data.tokenOut,
    amountIn: data.amountIn,
    best: res.best,
    bestNetOut: res.ranked[0]?.net ?? null,
    minOut: res.best ? minOut(res.best.amountOut, slippageBps) : null,
    slippageBps,
    ranked: res.ranked.map((r) => ({ venue: r.quote.venue, hops: r.quote.hops ?? 1, amountOut: r.quote.amountOut, net: r.net })),
    skipped: res.skipped.map((s) => ({ venue: s.quote?.venue ?? null, reason: s.reason })),
    note: 'Demo only. Re-quote, simulate (eth_call / estimateGas) and get an explicit user confirm before any send.',
  };
  console.log(JSON.stringify(out, replacer, 2));
  return res.best ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (c) => { process.exitCode = c; },
    (e) => { console.error(e.message); process.exitCode = 2; },
  );
}
