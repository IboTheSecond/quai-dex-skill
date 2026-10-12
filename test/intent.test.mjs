import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntent, learnPhrase, forgetPhrase, emptyLearned } from '../scripts/intent.mjs';

const EX_ADDR = '0x00' + '11'.repeat(19); // clearly fake EXAMPLE address, Cyprus-1 shaped
const EX_QI = '0x0080' + 'a1'.repeat(18); // Qi-shaped (top bit set after 0x00)
const p = (text, learned) => parseIntent(text, learned ? { learned } : {});

// ---- clear phrasings: act without asking ------------------------------------------------
const CLEAR = [
  ['swap 10 quai for hbome', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', kind: 'exact', value: '10', unit: 'QUAI' }],
  ['SWAP 10 QUAI FOR HBOME', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', kind: 'exact', value: '10' }],
  ['Swap 10 Quai For Hbome please', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ['yo can u swap 10 quai for hbome', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ['swap 10 quai -> hbome', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ['swap 10 QUAI->HBOME', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ['swap 10quai for hbome', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ['exchange 2.5k hbome into quai', { action: 'swap', tokenIn: 'HBOME', tokenOut: 'QUAI', value: '2500' }],
  ['swap 1,000 qaxe to quai', { action: 'swap', tokenIn: 'QAXE', tokenOut: 'QUAI', value: '1000' }],
  ['trade ten quai for qaxe', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'QAXE', value: '10' }],
  ['convert all my qaxe to hbome', { action: 'swap', tokenIn: 'QAXE', tokenOut: 'HBOME', kind: 'all' }],
  ['swap 25% of my quai for qaxe', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'QAXE', kind: 'percent', value: '25' }],
  ['quote 10 quai to hbome', { action: 'quote', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ['how much hbome do i get for 10 quai', { action: 'quote', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '10' }],
  ["what's the best route 5 QUAI -> WQI", { action: 'route', tokenIn: 'QUAI', tokenOut: 'WQI', value: '5' }],
  ['best route for 5 quai to wqi', { action: 'route', tokenIn: 'QUAI', tokenOut: 'WQI', value: '5' }],
  ['buy hbome with 500 quai', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', kind: 'exact', value: '500', unit: 'QUAI' }],
  ['swap one hundred quai for hbome', { action: 'swap', tokenIn: 'QUAI', tokenOut: 'HBOME', value: '100' }],
];
for (const [text, exp] of CLEAR) {
  test(`clear: "${text}"`, () => {
    const r = p(text);
    assert.equal(r.action, exp.action);
    assert.equal(r.tokenIn, exp.tokenIn);
    assert.equal(r.tokenOut, exp.tokenOut);
    if (exp.kind) assert.equal(r.amountIn.kind, exp.kind);
    if (exp.value) assert.equal(r.amountIn.value, exp.value);
    if (exp.unit) assert.equal(r.amountIn.unit, exp.unit);
    assert.ok(r.confidence.overall >= 0.85, `overall ${r.confidence.overall} should be >= 0.85`);
    assert.equal(r.question, null);
    assert.equal(r.slippageBps, 50);
    assert.ok(r.assumptions.some((a) => /50 bps/.test(a)), 'default slippage must be stated');
  });
}

// ---- act-and-state-assumption band (0.60 .. 0.85) ----------------------------------------
test('sell half my qaxe: percent, QUAI out assumed, band 0.6-0.85', () => {
  const r = p('sell half my qaxe');
  assert.equal(r.action, 'swap');
  assert.equal(r.verb, 'sell');
  assert.deepEqual([r.amountIn.kind, r.amountIn.value, r.amountIn.unit], ['percent', '50', 'QAXE']);
  assert.equal(r.tokenIn, 'QAXE');
  assert.equal(r.tokenOut, 'QUAI');
  assert.ok(r.confidence.overall >= 0.6 && r.confidence.overall < 0.85, String(r.confidence.overall));
  assert.ok(r.assumptions.some((a) => /QUAI/.test(a)));
  assert.equal(r.question, null);
});

test('buy $20 of HBOME with max 1% slippage: usd amount, QUAI paying assumed, 100 bps', () => {
  const r = p('buy $20 of HBOME with max 1% slippage');
  assert.equal(r.tokenOut, 'HBOME');
  assert.equal(r.tokenIn, 'QUAI');
  assert.deepEqual([r.amountIn.kind, r.amountIn.value, r.amountIn.unit], ['usd', '20', 'USD']);
  assert.equal(r.slippageBps, 100);
  assert.ok(r.confidence.slippage >= 0.9);
  assert.ok(!r.assumptions.some((a) => /50 bps/.test(a)));
  assert.ok(r.confidence.overall >= 0.6 && r.confidence.overall < 0.85);
  assert.equal(r.question, null);
});

test('buy 500 hbome is an exact-out request and says so', () => {
  const r = p('buy 500 hbome');
  assert.equal(r.exactOut, true);
  assert.equal(r.tokenOut, 'HBOME');
  assert.equal(r.tokenIn, 'QUAI');
  assert.equal(r.amountIn.unit, 'HBOME');
  assert.ok(r.assumptions.some((a) => /receive|exact-out|exact out/i.test(a)));
  assert.ok(r.confidence.overall >= 0.6 && r.confidence.overall < 0.85);
});

test('dump all qaxe sells everything for QUAI (assumed)', () => {
  const r = p('dump all qaxe');
  assert.equal(r.tokenIn, 'QAXE');
  assert.equal(r.tokenOut, 'QUAI');
  assert.equal(r.amountIn.kind, 'all');
  assert.ok(r.confidence.overall >= 0.6);
});

test('typo in the verb lowers action confidence but still acts', () => {
  const r = p('swpa 10 quai for hbome');
  assert.equal(r.action, 'swap');
  assert.ok(r.confidence.action < 0.95 && r.confidence.action >= 0.6);
  assert.ok(r.assumptions.some((a) => /swpa/.test(a)));
  assert.equal(r.question, null);
});

test('typo in a token is fuzzy-matched with lowered confidence and a stated assumption', () => {
  const r = p('swap 10 quai for hbmoe');
  assert.equal(r.tokenOut, 'HBOME');
  assert.ok(r.confidence.tokenOut < 0.85 && r.confidence.tokenOut >= 0.6);
  assert.ok(r.confidence.overall < 0.85 && r.confidence.overall >= 0.6);
  assert.ok(r.assumptions.some((a) => /hbmoe/.test(a) && /HBOME/.test(a)));
  assert.equal(r.question, null);
});

test('transposed token letters (qaui) still resolve to QUAI', () => {
  const r = p('swap 10 qaui for hbome');
  assert.equal(r.tokenIn, 'QUAI');
  assert.ok(r.confidence.tokenIn < 0.85);
});

// ---- slippage and deadline ----------------------------------------------------------------
test('slippage forms: percent, decimal percent, bps, "max N%"', () => {
  assert.equal(p('swap 10 quai for hbome slippage 2%').slippageBps, 200);
  assert.equal(p('swap 10 quai for hbome, slippage 0.5%').slippageBps, 50);
  assert.equal(p('swap 10 quai for hbome with 100 bps slippage').slippageBps, 100);
  assert.equal(p('swap 10 quai for hbome with 1 percent slippage').slippageBps, 100);
  assert.equal(p('swap 10 quai for hbome max 1%').slippageBps, 100);
});

test('slippage percent is not mistaken for a percent amount', () => {
  const r = p('swap 10 quai for hbome slippage 2%');
  assert.equal(r.amountIn.kind, 'exact');
  assert.equal(r.amountIn.value, '10');
});

test('absurd slippage (60%) forces a question', () => {
  const r = p('swap 10 quai for hbome slippage 60%');
  assert.equal(r.slippageBps, 6000);
  assert.ok(r.confidence.slippage < 0.6);
  assert.ok(r.confidence.overall < 0.6);
  assert.match(r.question, /slippage|60/i);
});

test('deadline phrases map to seconds, default is stated', () => {
  assert.equal(p('swap 10 quai for hbome within 5 minutes').deadlineSec, 300);
  assert.equal(p('swap 10 quai for hbome deadline 90 seconds').deadlineSec, 90);
  const d = p('swap 10 quai for hbome');
  assert.equal(d.deadlineSec, 600);
  assert.ok(d.assumptions.some((a) => /deadline/i.test(a)));
});

// ---- addresses ----------------------------------------------------------------------------
test('a Cyprus-1 shaped address is accepted with high confidence', () => {
  const r = p(`swap 5 quai for ${EX_ADDR}`);
  assert.equal(r.tokenOut.toLowerCase(), EX_ADDR);
  assert.ok(r.confidence.tokenOut >= 0.9);
});

test('a Qi-shaped address is rejected with a question', () => {
  const r = p(`swap 5 quai for ${EX_QI}`);
  assert.ok(r.confidence.tokenOut < 0.6);
  assert.ok(r.question);
  assert.match(r.question, /Qi/);
});

test('an address outside Cyprus-1 lowers confidence and is flagged', () => {
  const r = p(`swap 5 quai for 0x10${'a1'.repeat(19)}`);
  assert.ok(r.confidence.tokenOut <= 0.65);
  assert.ok(r.assumptions.concat([r.question || '']).some((a) => /zone|Cyprus-1/i.test(a)));
});

// ---- ambiguous: must ask exactly one question ----------------------------------------------
const ASK = [
  ['swap some quai', /how much|amount|receive|which/i, ['amount', 'tokenOut']],
  ['swap hbome', /how much|receive|amount|which/i, []],
  ['swap 10 for hbome', /spend|sell|which token|from/i, ['tokenIn']],
  ['sell 10', /which token|sell/i, ['tokenIn']],
  ['swap 10 quai', /receive|get|which token/i, ['tokenOut']],
  ['hello there', /swap|quote|route/i, ['action']],
  ['', /swap|quote|route/i, ['action']],
  ['swap 10 quai for qaxe or hbome', /QAXE/, []],
  ['swap 10 quai to quai', /both|same|receive/i, []],
  ['swap 10 quai for zorb', /zorb/i, []],
  ['swap 10 qai for hbome', /QUAI/, []],
];
for (const [text, re, missing] of ASK) {
  test(`ambiguous asks one question: "${text}"`, () => {
    const r = p(text);
    assert.ok(r.confidence.overall < 0.6, `overall ${r.confidence.overall} should be < 0.6`);
    assert.equal(typeof r.question, 'string');
    assert.match(r.question, re);
    assert.equal((r.question.match(/\?/g) || []).length, 1, 'exactly one question mark');
    for (const m of missing) assert.ok(r.missing.includes(m), `missing should include ${m}: ${r.missing}`);
  });
}

test('"qaxe or hbome" question names both options', () => {
  const r = p('swap 10 quai for qaxe or hbome');
  assert.match(r.question, /QAXE/);
  assert.match(r.question, /HBOME/);
});

test('"qai" is a tie between QUAI and QI and asks which', () => {
  const r = p('swap 10 qai for hbome');
  assert.match(r.question, /QUAI/);
  assert.match(r.question, /QI/);
});


test('"in 2 minutes" is a deadline, not a second amount', () => {
  const r = p('swap 100 hbome to quai in 2 minutes');
  assert.equal(r.deadlineSec, 120);
  assert.equal(r.amountIn.value, '100');
  assert.equal(r.question, null);
});

test('more than two tokens named asks which pair', () => {
  const r = p('swap 10 quai for hbome and qaxe');
  assert.ok(r.confidence.overall < 0.6);
  assert.match(r.question, /HBOME/);
  assert.match(r.question, /QAXE/);
});

// ---- invariants ---------------------------------------------------------------------------
test('every result: confidences in [0,1], overall is the minimum, question iff overall < 0.6', () => {
  const texts = ['swap 10 quai for hbome', 'sell half my qaxe', 'swap some quai', '', 'hello', 'buy 500 hbome', 'swap 10 quai for zorb'];
  for (const t of texts) {
    const r = p(t);
    const c = r.confidence;
    const fields = [c.action, c.amount, c.tokenIn, c.tokenOut, c.slippage];
    for (const v of [...fields, c.overall]) assert.ok(v >= 0 && v <= 1, `${t}: ${v}`);
    assert.equal(c.overall, Math.min(...fields), t);
    assert.equal(r.question === null, c.overall >= 0.6, t);
    assert.ok(Array.isArray(r.assumptions) && Array.isArray(r.missing));
  }
});

test('output shape has every documented field', () => {
  const r = p('swap 10 quai for hbome');
  for (const k of ['action', 'amountIn', 'tokenIn', 'tokenOut', 'slippageBps', 'deadlineSec', 'confidence', 'assumptions', 'missing', 'question']) {
    assert.ok(k in r, `missing field ${k}`);
  }
  for (const k of ['value', 'unit', 'kind']) assert.ok(k in r.amountIn);
  for (const k of ['action', 'amount', 'tokenIn', 'tokenOut', 'slippage', 'overall']) assert.ok(k in r.confidence);
});

// ---- compound request (two intents in one sentence) ---------------------------------------
test('"Buyback hbome with 500 and qaxe with 500" splits into two buys', () => {
  const r = p('Buyback hbome with 500 and qaxe with 500');
  assert.equal(r.intents.length, 2);
  assert.equal(r.intents[0].tokenOut, 'HBOME');
  assert.equal(r.intents[1].tokenOut, 'QAXE');
  for (const i of r.intents) {
    assert.equal(i.verb, 'buy');
    assert.equal(i.amountIn.value, '500');
    assert.equal(i.tokenIn, 'QUAI');
    assert.ok(i.confidence.overall >= 0.6);
  }
  assert.ok(r.assumptions.some((a) => /separate|one at a time/i.test(a)));
});

test('two-part swap sentence splits into two intents', () => {
  const r = p('swap 10 quai for hbome and 5 quai for qaxe');
  assert.equal(r.intents.length, 2);
  assert.deepEqual(r.intents.map((i) => i.tokenOut), ['HBOME', 'QAXE']);
});

test('a single swap with "and" in a token list does not split', () => {
  assert.equal(p('swap 10 quai and hbome').intents, undefined);
});

// ---- learning -----------------------------------------------------------------------------
test('learning a typo alias raises confidence to >= 0.9', () => {
  const before = p('swap 10 quai for hbmoe');
  const learned = learnPhrase(emptyLearned(), 'hbmoe', 'HBOME');
  const after = p('swap 10 quai for hbmoe', learned);
  assert.ok(before.confidence.tokenOut < 0.85);
  assert.ok(after.confidence.tokenOut >= 0.9);
  assert.equal(after.tokenOut, 'HBOME');
  assert.ok(after.confidence.overall >= 0.85);
  assert.equal(after.question, null);
});

test('learning an unknown token turns a question into an action', () => {
  const before = p('swap 10 quai for zorb');
  assert.ok(before.question);
  const learned = learnPhrase(emptyLearned(), 'zorb', 'ZORB');
  const after = p('swap 10 quai for zorb', learned);
  assert.equal(after.tokenOut, 'ZORB');
  assert.ok(after.confidence.tokenOut >= 0.9);
  assert.equal(after.question, null);
});

test('learning a correction overrides the fuzzy guess', () => {
  const learned = learnPhrase(emptyLearned(), 'hbmoe', 'QAXE');
  assert.equal(p('swap 10 quai for hbmoe', learned).tokenOut, 'QAXE');
});

test('learning a custom verb', () => {
  const before = p('yeet 5 quai for hbome');
  assert.ok(before.confidence.action <= 0.65, 'unknown verb is only inferred');
  assert.ok(before.assumptions.some((a) => /No verb/.test(a)));
  const learned = learnPhrase(emptyLearned(), 'yeet', 'swap');
  const r = p('yeet 5 quai for hbome', learned);
  assert.equal(r.action, 'swap');
  assert.ok(r.confidence.action >= 0.9);
  assert.equal(r.question, null);
});

test('learning a multi-word phrase for a token', () => {
  const learned = learnPhrase(emptyLearned(), 'the usual coin', 'HBOME');
  const r = p('swap 10 quai for the usual coin', learned);
  assert.equal(r.tokenOut, 'HBOME');
  assert.ok(r.confidence.tokenOut >= 0.9);
});

test('learning a slippage word and a saved default slippage', () => {
  const l1 = learnPhrase(emptyLearned(), 'tight', 'bps:30');
  const r1 = p('swap 10 quai for hbome tight', l1);
  assert.equal(r1.slippageBps, 30);
  assert.ok(r1.confidence.slippage >= 0.9);
  const l2 = learnPhrase(emptyLearned(), 'default slippage', 'bps:100');
  const r2 = p('swap 10 quai for hbome', l2);
  assert.equal(r2.slippageBps, 100);
  assert.ok(r2.assumptions.some((a) => /saved default/i.test(a)));
});

test('learnPhrase is pure, case-insensitive, validates input; forgetPhrase removes', () => {
  const base = emptyLearned();
  const l = learnPhrase(base, '  HbMoE ', 'hbome');
  assert.deepEqual(base, emptyLearned());
  assert.equal(l.aliases.hbmoe.meaning, 'HBOME');
  assert.equal(l.version, 1);
  assert.throws(() => learnPhrase(base, '', 'HBOME'));
  assert.throws(() => learnPhrase(base, 'x', ''));
  assert.throws(() => learnPhrase(base, 'x', 'bps:99999'));
  const f = forgetPhrase(l, 'HBMOE');
  assert.equal(f.aliases.hbmoe, undefined);
  assert.equal(p('swap 10 quai for hbmoe', f).confidence.tokenOut < 0.85, true);
});

test('malformed learned data is ignored, never crashes', () => {
  assert.doesNotThrow(() => p('swap 10 quai for hbome', { aliases: 'nope' }));
  assert.doesNotThrow(() => parseIntent('swap 10 quai for hbome', { learned: null }));
  assert.doesNotThrow(() => parseIntent(undefined));
});

// ---- CLI ----------------------------------------------------------------------------------
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'intent.mjs');
const cli = (cwd, ...args) => JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' }));

test('CLI: parse, learn writes .quai-dex/learned.json, re-parse is more confident, forget reverts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qdex-'));
  try {
    const before = cli(dir, 'parse', 'swap 10 quai for hbmoe');
    assert.ok(before.confidence.tokenOut < 0.85);
    const learnRes = cli(dir, 'learn', 'hbmoe', 'HBOME');
    assert.equal(learnRes.ok, true);
    const file = join(dir, '.quai-dex', 'learned.json');
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).aliases.hbmoe.meaning, 'HBOME');
    const after = cli(dir, 'parse', 'swap 10 quai for hbmoe');
    assert.ok(after.confidence.tokenOut >= 0.9);
    const forgot = cli(dir, 'forget', 'hbmoe');
    assert.equal(forgot.ok, true);
    assert.ok(cli(dir, 'parse', 'swap 10 quai for hbmoe').confidence.tokenOut < 0.85);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: unknown subcommand exits non-zero with usage on stderr', () => {
  let code = 0;
  try { execFileSync(process.execPath, [SCRIPT, 'wat'], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.equal(code, 2);
});
