// Human-language swap / quote / route intent parser with confidence scores and learning.
// Zero dependencies, Node 20+.
//
//   node scripts/intent.mjs parse "swap 10 quai for hbome"
//   node scripts/intent.mjs learn <phrase> <meaning>     (meaning: TOKEN | 0x address | swap|buy|sell|quote|route | bps:N)
//   node scripts/intent.mjs forget <phrase>
//   node scripts/intent.mjs show
//
// Learned data lives in ./.quai-dex/learned.json (current working directory).
// The built-in symbols below are PARSING HINTS only. They are not on-chain facts:
// always resolve a symbol to a contract address from the user's token list.

import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';

export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_DEADLINE_SEC = 600;
const ASK_BELOW = 0.6;
const HISTORY_MAX = 100;

const BUILTIN_TOKENS = ['QUAI', 'WQUAI', 'QI', 'WQI', 'HBOME', 'QAXE'];
const NATIVE = 'QUAI';

const VERB_WORDS = {
  swap: ['swap', 'exchange', 'trade', 'convert', 'flip'],
  buy: ['buy', 'purchase', 'buyback', 'grab', 'acquire', 'ape'],
  sell: ['sell', 'dump', 'offload', 'unload'],
  quote: ['quote', 'price', 'estimate'],
  route: ['route', 'routes', 'routing'],
};
const VERB_OF = new Map();
for (const [canon, words] of Object.entries(VERB_WORDS)) for (const w of words) VERB_OF.set(w, canon);
const FUZZY_VERBS = [...VERB_OF.keys()].filter((w) => w.length >= 4);
const ACTIONS = new Set(['swap', 'buy', 'sell', 'quote', 'route']);

const PREPS = new Set(['to', 'for', 'into', 'with', 'using', 'from', 'via', 'vs', 'against', 'paying', 'in']);
const OUT_PREPS = new Set(['to', 'for', 'into', 'vs', 'against']);
const IN_PREPS = new Set(['with', 'using', 'from', 'via', 'paying', 'in', 'for']);

const FILL = new Set((
  'of my the a an some any more worth total balance tokens token coin coins bag stack holdings please pls plz thanks thx ' +
  'can could would should you u i me us we want wanna need like just really now asap quickly fast yo hey hi hello ok okay ' +
  'so then if is it its what whats how much do does did get best cheapest cheap good way ways on at by be will that this ' +
  'these those and but also out help let lets go make give show tell find look see check there here again maybe'
).split(' '));

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
// Words that negate or cancel a request. A negated request is never acted on as a normal swap.
const NEGATION = /\b(?:dont|doesnt|didnt|wont|never|nevermind|cancel\w*|stop|abort|not)\b/;
const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;

// ---- small helpers -------------------------------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;

/** Optimal-string-alignment edit distance (insert, delete, substitute, adjacent swap). */
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

function normDec(str) {
  let [i, f = ''] = String(str).split('.');
  i = i.replace(/^0+(?=\d)/, '') || '0';
  f = f.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}
function shiftDecimal(str, shift) {
  const [i, f = ''] = String(str).split('.');
  if (!shift) return normDec(str);
  const digits = i + f;
  const pointAt = i.length + shift;
  const out = pointAt >= digits.length ? digits + '0'.repeat(pointAt - digits.length) : `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  return normDec(out);
}
const scale = (n, suffix) => (suffix === 'k' ? shiftDecimal(n, 3) : suffix === 'm' ? shiftDecimal(n, 6) : normDec(n));
const bpsFromPercent = (n) => Math.round(parseFloat(n) * 100);

function wordsToNumber(words) {
  let total = 0;
  let cur = 0;
  for (const w of words) {
    if (w in NUM_WORDS) cur += NUM_WORDS[w];
    else if (w === 'hundred') cur = (cur || 1) * 100;
    else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
    else if (w === 'million') { total += (cur || 1) * 1e6; cur = 0; }
  }
  return String(total + cur);
}

// ---- learned data --------------------------------------------------------------------------
export function emptyLearned() {
  return { version: 1, aliases: {}, prefs: {}, history: [] };
}

function normPhrase(phrase) {
  return String(phrase ?? '')
    .toLowerCase()
    .replace(/[’‘`´']/g, '')
    .replace(/[^a-z0-9@._\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeLearned(l) {
  const out = emptyLearned();
  if (!l || typeof l !== 'object') return out;
  if (l.aliases && typeof l.aliases === 'object' && !Array.isArray(l.aliases)) {
    for (const [k, v] of Object.entries(l.aliases)) {
      if (!v || typeof v !== 'object') continue;
      if (!['token', 'action', 'bps'].includes(v.kind)) continue;
      if (v.meaning === undefined || v.meaning === null) continue;
      const key = normPhrase(k);
      if (key) out.aliases[key] = v;
    }
  }
  const bps = l.prefs?.slippageBps;
  if (Number.isInteger(bps) && bps >= 0 && bps <= 10000) out.prefs.slippageBps = bps;
  if (Array.isArray(l.history)) {
    out.history = l.history
      .filter((h) => h && typeof h === 'object' && typeof h.at === 'string' && (h.op === 'learn' || h.op === 'forget') && typeof h.phrase === 'string')
      .slice(-HISTORY_MAX);
  }
  return out;
}

/** Shared Qi / zone check for a lowercase 0x address. Returns { kind, conf, note, ask }. */
function checkAddress(addr) {
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return { kind: 'malformed', conf: 0.3, note: null, ask: `That address looks malformed (${addr.slice(0, 10)}...). What is the full 0x contract address?` };
  }
  if (/^0x00[89a-f]/.test(addr)) {
    return { kind: 'qi', conf: 0.3, note: null, ask: "That address looks like a Qi (UTXO) address, not a Quai token contract. What is the token's Cyprus-1 contract address?" };
  }
  if (!addr.startsWith('0x00')) {
    return { kind: 'zone', conf: 0.6, note: `Address ${addr.slice(0, 6)}... is not in the Cyprus-1 zone (Cyprus-1 addresses start with 0x00); confirm the zone before use.`, ask: null };
  }
  return { kind: 'ok', conf: 0.95, note: null, ask: null };
}

function classifyMeaning(meaning) {
  const m = String(meaning ?? '').trim();
  if (!m) throw new Error('meaning must not be empty');
  const bps = /^bps:(\d{1,5})$/i.exec(m);
  if (bps) {
    const n = Number(bps[1]);
    if (n > 10000) throw new Error('bps must be 0..10000');
    return { kind: 'bps', meaning: n };
  }
  if (ACTIONS.has(m.toLowerCase())) return { kind: 'action', meaning: m.toLowerCase() };
  if (/^0x[0-9a-fA-F]{40}$/.test(m)) {
    const addr = m.toLowerCase();
    const { kind } = checkAddress(addr);
    if (kind === 'qi') throw new Error("That is a Qi (UTXO) address, not a Quai token contract. Learn the token's Cyprus-1 contract address instead.");
    if (kind === 'zone') throw new Error("That address is not in the Cyprus-1 zone (Cyprus-1 addresses start with 0x00). Learn the token's Cyprus-1 contract address instead.");
    return { kind: 'token', meaning: addr };
  }
  if (/^[A-Za-z0-9]{1,12}$/.test(m)) return { kind: 'token', meaning: m.toUpperCase() };
  throw new Error('meaning must be a token symbol, a 0x address, an action (swap|buy|sell|quote|route) or bps:N');
}

/** Pure: returns a new learned object with the phrase remembered. */
export function learnPhrase(learned, phrase, meaning, now = new Date()) {
  const key = normPhrase(phrase);
  if (!key) throw new Error('phrase must not be empty');
  const cls = classifyMeaning(meaning);
  const next = sanitizeLearned(learned);
  next.history = next.history.slice(-(HISTORY_MAX - 1));
  const at = now.toISOString();
  if (key === 'default slippage') {
    if (cls.kind !== 'bps') throw new Error('"default slippage" needs a meaning like bps:100');
    next.prefs.slippageBps = cls.meaning;
  } else {
    if (Object.keys(next.aliases).length >= 500 && !next.aliases[key]) throw new Error('too many learned phrases (500)');
    const prev = learned?.aliases?.[key];
    next.aliases[key] = { kind: cls.kind, meaning: cls.meaning, count: (prev?.count || 0) + 1, updated: at };
  }
  next.history.push({ at, op: 'learn', phrase: key, meaning: String(cls.meaning) });
  return next;
}

/** Pure: returns a new learned object without the phrase. */
export function forgetPhrase(learned, phrase, now = new Date()) {
  const key = normPhrase(phrase);
  const next = sanitizeLearned(learned);
  next.history = next.history.slice(-(HISTORY_MAX - 1));
  if (key === 'default slippage') delete next.prefs.slippageBps;
  else delete next.aliases[key];
  next.history.push({ at: now.toISOString(), op: 'forget', phrase: key });
  return next;
}

// ---- text preparation ----------------------------------------------------------------------
function prepare(raw) {
  let s = String(raw ?? '').toLowerCase().normalize('NFKC');
  s = s.replace(/[→⇒➜➔]|-{1,2}>|=>/g, ' to ');
  s = s.replace(/[’‘`´']/g, '');
  s = s.replace(/\bwrapped\s+(quai|qi)\b/g, 'w$1');
  const addrs = [];
  s = s.replace(/0x[0-9a-f]+/g, (m) => {
    addrs.push(m);
    return ` zzaddr${addrs.length - 1} `;
  });
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  s = s.replace(/(\d)(?=[a-z]{2,})/g, '$1 ');
  s = s.replace(/\$(?=[a-z])/g, ' ');
  s = s.replace(/\bhow (?:much|many)\b/g, ' zzquote ');
  s = s.replace(/\bwhat (?:would|will|do|can|could|did) (?:i|you|we|u) (?:get|receive)\b/g, ' zzquote ');
  return { s, addrs };
}

function extractSlippage(s) {
  const found = [];
  const take = (re, build) => {
    s = s.replace(re, (...m) => {
      found.push(build(m));
      return ' ';
    });
  };
  const SLIP = String.raw`(?:slippage|slipage|slippge|slip)(?:\s+tolerance)?`;
  const UNITS = String.raw`(%|percent|pct|bps|bp|basis\s+points?)`;
  take(new RegExp(String.raw`(?:(?:with|at|using)\s+)?(?:max(?:imum)?\s+)?(?:a\s+)?${NUM}\s*${UNITS}\s*(?:max\s+)?${SLIP}`, 'g'),
    (m) => ({ n: m[1], unit: m[2], explicit: true }));
  take(new RegExp(String.raw`(?:max(?:imum)?\s+)?${SLIP}\s*(?:of|at|to|=|<=|under|max|maximum)?\s*${NUM}\s*${UNITS}?`, 'g'),
    (m) => ({ n: m[1], unit: m[2] || '%', explicit: true, noUnit: !m[2] }));
  take(new RegExp(String.raw`\bmax(?:imum)?\s+${NUM}\s*(%|percent|pct)`, 'g'),
    (m) => ({ n: m[1], unit: m[2], explicit: false }));
  if (!found.length) return { s, slip: null };
  const f = found[0];
  const bps = /^b/.test(f.unit) ? Math.round(parseFloat(f.n)) : bpsFromPercent(f.n);
  return { s, slip: { bps, explicit: f.explicit, noUnit: !!f.noUnit } };
}

function extractDeadline(s) {
  const re = new RegExp(
    String.raw`(?:(?:within|deadline(?:\s+of)?|expires?(?:\s+in)?|valid\s+for|timeout(?:\s+of)?|in\s+the\s+next)\s*${NUM}\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b|\bin\s+${NUM}\s*(seconds|secs|minutes|mins|hours|hrs)\b)`, 'g');
  let sec = null;
  s = s.replace(re, (_m, n, unit, n2, unit2) => {
    n = n ?? n2;
    unit = unit ?? unit2;
    if (sec === null) sec = Math.round(parseFloat(n) * (/^h/.test(unit) ? 3600 : /^m/.test(unit) ? 60 : 1));
    return ' ';
  });
  return { s, deadlineSec: sec };
}

function extractAmounts(s) {
  const amts = [];
  const put = (a) => {
    amts.push(a);
    return ` zzamt${amts.length - 1} `;
  };
  const lb = String.raw`(?<![a-z0-9.])`;
  // A minus sign directly before a number (not part of an arrow, a range or a word) makes the amount negative.
  let negative = false;
  s = s.replace(/(^|[\s(])-(?=\.?\d)/g, (_m, pre) => {
    negative = true;
    return `${pre} zzneg `;
  });
  s = s.replace(new RegExp(String.raw`\$\s*${NUM}([km])?(?![a-z0-9])`, 'g'), (_m, n, k) => put({ kind: 'usd', value: scale(n, k), conf: 0.85 }));
  s = s.replace(new RegExp(String.raw`${lb}${NUM}([km])?\s*(?:usd|dollars?|bucks|\$)(?![a-z])`, 'g'), (_m, n, k) => put({ kind: 'usd', value: scale(n, k), conf: 0.85 }));
  s = s.replace(new RegExp(String.raw`${lb}${NUM}\s*(?:%|percent|pct)`, 'g'), (_m, n) => put({ kind: 'percent', value: normDec(n), conf: 0.92 }));
  s = s.replace(new RegExp(String.raw`${lb}${NUM}([km])?(?![a-z0-9.])`, 'g'), (_m, n, k) => put({ kind: 'exact', value: scale(n, k), conf: 0.95 }));
  const nw = Object.keys(NUM_WORDS).concat(['hundred', 'thousand', 'million']).join('|');
  s = s.replace(new RegExp(String.raw`\b(?:(?:${nw})\b[\s-]*)+`, 'g'), (m) => {
    const value = wordsToNumber(m.trim().split(/[\s-]+/));
    return put({ kind: 'exact', value: normDec(value), conf: 0.9, spoken: true });
  });
  s = s.replace(/\b(half|quarter)\b/g, (_m, w) => put({ kind: 'percent', value: w === 'half' ? '50' : '25', conf: 0.92 }));
  s = s.replace(/\b(all|everything|entire|whole|max|maximum)\b/g, (_m, w) => put({ kind: 'all', value: null, conf: /^m/.test(w) ? 0.85 : 0.92 }));
  return { s, amts, negative };
}

// ---- clause splitting (two requests in one sentence) -------------------------------------
function splitClauses(s) {
  const parts = s.split(/\s*(?:;|&|\band then\b|\bthen\b|\band\b|,\s+)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const withAmounts = parts.filter((p) => extractAmounts(p).amts.length > 0);
  return withAmounts.length === parts.length ? parts : null;
}

// ---- word classification -------------------------------------------------------------------
function buildLexicon(learned, extraTokens) {
  const symbols = new Set(BUILTIN_TOKENS);
  for (const t of extraTokens || []) if (/^[A-Za-z0-9]{1,12}$/.test(String(t))) symbols.add(String(t).toUpperCase());
  for (const v of Object.values(learned.aliases)) if (v.kind === 'token' && !/^0x/.test(String(v.meaning))) symbols.add(String(v.meaning).toUpperCase());
  const phrases = Object.entries(learned.aliases)
    .map(([k, v]) => ({ words: k.split(' '), v }))
    .sort((a, b) => b.words.length - a.words.length);
  return { symbols, lower: [...symbols].map((x) => ({ sym: x, low: x.toLowerCase() })), phrases };
}

function fuzzyToken(word, lex) {
  if (word.length < 3) return null;
  let best = Infinity;
  let hits = [];
  for (const { sym, low } of lex.lower) {
    const d = editDistance(word, low);
    if (d < best) { best = d; hits = [sym]; } else if (d === best) hits.push(sym);
  }
  const limit = word.length >= 6 ? 2 : 1;
  if (best > limit || best === 0) return null;
  const conf = best === 2 ? 0.6 : word.length >= 5 ? 0.74 : word.length === 4 ? 0.7 : 0.62;
  return { syms: hits, conf, dist: best };
}

function fuzzyVerb(word) {
  if (word.length < 4) return null;
  let best = Infinity;
  const hits = new Set();
  for (const v of FUZZY_VERBS) {
    const d = editDistance(word, v);
    if (d < best) { best = d; hits.clear(); hits.add(VERB_OF.get(v)); } else if (d === best) hits.add(VERB_OF.get(v));
  }
  return best === 1 && hits.size === 1 ? [...hits][0] : null;
}

const cleanWord = (w) => w.replace(/^[^a-z0-9@$_]+|[^a-z0-9@$_]+$/g, '');

function classify(words, ctx) {
  const { lex, addrs, amts } = ctx;
  const items = [];
  const prevSig = () => {
    for (let k = items.length - 1; k >= 0; k--) if (items[k].type !== 'fill') return items[k];
    return null;
  };
  let i = 0;
  while (i < words.length) {
    const w = words[i];

    // learned phrases first (longest first)
    let hit = null;
    for (const ph of lex.phrases) {
      if (ph.words.every((pw, k) => words[i + k] === pw)) { hit = ph; break; }
    }
    if (hit) {
      const { kind, meaning } = hit.v;
      const phrase = hit.words.join(' ');
      if (kind === 'token' && /^0x/i.test(String(meaning))) items.push(addrItem(String(meaning).toLowerCase(), prevSig(), items, 'learned', phrase));
      else if (kind === 'token') items.push(tokItem(String(meaning), 0.95, 'learned', phrase, prevSig(), items));
      else if (kind === 'action') items.push({ type: 'verb', canon: meaning, conf: 0.95, word: phrase, learned: true });
      else if (kind === 'bps') items.push({ type: 'slip', bps: Number(meaning), word: phrase });
      i += hit.words.length;
      continue;
    }

    if (/^zzamt\d+$/.test(w)) {
      const amt = amts[Number(w.slice(5))];
      const pv = prevSig();
      items.push({ type: 'amt', amt, prepBefore: pv && pv.type === 'prep' ? pv.word : null, word: w });
    } else if (/^zzaddr\d+$/.test(w)) {
      items.push(addrItem(addrs[Number(w.slice(6))], prevSig(), items));
    } else if (w === 'zzquote') {
      items.push({ type: 'verb', canon: 'quote', conf: 0.9, word: 'how much' });
    } else if (VERB_OF.has(w)) {
      items.push({ type: 'verb', canon: VERB_OF.get(w), conf: 0.97, word: w });
    } else if (w === 'get') {
      items.push({ type: 'verb', canon: 'buy', conf: 0.75, word: w, weak: true });
    } else if (lex.symbols.has(w.toUpperCase()) && /^[a-z0-9]+$/.test(w)) {
      items.push(tokItem(w.toUpperCase(), 0.97, 'exact', w, prevSig(), items));
    } else if (PREPS.has(w)) {
      items.push({ type: 'prep', word: w });
    } else if (w === 'or') {
      items.push({ type: 'or', word: w });
    } else if (FILL.has(w)) {
      items.push({ type: 'fill', word: w });
    } else {
      const fv = fuzzyVerb(w);
      const ft = fuzzyToken(w, lex);
      const pv = prevSig();
      const slot = pv && ['amt', 'verb', 'prep', 'or', 'tok'].includes(pv.type);
      if (fv && !ft) {
        items.push({ type: 'verb', canon: fv, conf: 0.8, word: w, fuzzy: true });
      } else if (ft && slot) {
        const it = tokItem(ft.syms[0], ft.syms.length > 1 ? 0.4 : ft.conf, 'fuzzy', w, pv, items);
        if (ft.syms.length > 1) it.tie = ft.syms;
        items.push(it);
      } else if (slot && /^[a-z][a-z0-9]{1,9}$/.test(w)) {
        items.push(tokItem(w.toUpperCase(), 0.45, 'unknown', w, pv, items));
      } else {
        items.push({ type: 'noise', word: w });
      }
    }
    i++;
  }
  return items;
}

function tokItem(sym, conf, source, word, pv, items) {
  const it = { type: 'tok', sym, conf, source, word, prep: null, afterAmt: null, isAlt: false, alts: [] };
  if (pv && pv.type === 'prep') it.prep = pv.word;
  if (pv && pv.type === 'amt') it.afterAmt = pv;
  if (pv && pv.type === 'or') {
    const idx = items.lastIndexOf(pv);
    const before = items.slice(0, idx).reverse().find((x) => x.type !== 'fill');
    if (before && before.type === 'tok') { it.isAlt = true; before.alts.push(sym); }
  }
  return it;
}

function addrItem(addr, pv, items, source = 'address', word = addr) {
  const { conf, note, ask } = checkAddress(addr);
  const it = tokItem(addr, conf, source, word, pv, items);
  it.note = note;
  it.ask = ask;
  return it;
}

// ---- single clause ---------------------------------------------------------------------------
function parseClause(clause, ctx) {
  const { s: withAmts, amts, negative } = extractAmounts(clause);
  const words = withAmts.split(/\s+/).map(cleanWord).filter((w) => w && w !== 'zzneg');
  const items = classify(words, { lex: ctx.lex, addrs: ctx.addrs, amts });
  const assumptions = [];

  // action
  const verbItems = items.filter((x) => x.type === 'verb');
  const strong = verbItems.filter((v) => !v.weak);
  let verb = null;
  let actionConf = 0.2;
  let actionAsk = 'Do you want to swap, get a quote, or find the best route?';
  if (strong.length || verbItems.length) {
    const pool = strong.length ? strong : verbItems;
    const classes = new Set(pool.map((v) => v.canon));
    const pickItem = (c) => pool.find((v) => v.canon === c);
    if (classes.has('route')) verb = 'route';
    else if (classes.has('quote')) verb = 'quote';
    else {
      const exec = [...classes].filter((c) => c !== 'swap');
      if (exec.length > 1) {
        verb = pool[0].canon;
        actionConf = 0.55;
        actionAsk = 'Do you want to buy or sell?';
      } else verb = exec[0] || 'swap';
    }
    const it = pickItem(verb) || pool[0];
    if (actionConf !== 0.55) actionConf = it.conf;
    if ((verb === 'route' || verb === 'quote') && [...classes].some((c) => !['route', 'quote'].includes(c))) {
      actionConf = Math.min(actionConf, 0.8);
      assumptions.push(`The request also mentions ${[...classes].filter((c) => !['route', 'quote'].includes(c)).join('/')}; treating it as a ${verb} (read-only) first.`);
    }
    if (it.fuzzy) assumptions.push(`Read "${it.word}" as "${verb}".`);
    if (it.learned) assumptions.push(`"${it.word}" means ${verb} (learned earlier).`);
  } else if (ctx.forceVerb) {
    verb = ctx.forceVerb;
    actionConf = 0.9;
    assumptions.push(`No verb in this part; reusing "${verb}" from the first request.`);
  }
  const mentionsAll = items.filter((x) => x.type === 'tok');
  const mentions = mentionsAll.filter((m) => !m.isAlt);
  if (!verb && amts.length && mentions.length >= 2) {
    verb = 'swap';
    actionConf = 0.65;
    assumptions.push('No verb found; reading this as a swap.');
  }
  const action = verb === null ? null : verb === 'quote' || verb === 'route' ? verb : 'swap';

  // slippage via learned word
  const slipItem = items.find((x) => x.type === 'slip');

  // amount
  const amtItems = items.filter((x) => x.type === 'amt');
  const amtItem = amtItems[0] || null;
  const unit = amtItem ? mentions.find((m) => m.afterAmt === amtItem) || null : null;

  // roles
  const rest = mentions;
  let tin = null;
  let tout = null;
  let exactOut = false;
  if (verb === 'buy') {
    if (unit) {
      const spend = unit.word && items[items.indexOf(unit) + 1]?.word === 'worth';
      if (amtItem.amt.kind === 'usd' && !spend) tout = unit;
      else if (spend || IN_PREPS.has(amtItem.prepBefore) || amtItem.amt.kind !== 'exact') tin = unit;
      else { tout = unit; exactOut = true; }
    }
    if (!tin) tin = rest.find((m) => m !== tout && IN_PREPS.has(m.prep)) || null;
    if (!tout) tout = rest.find((m) => m !== tin && !IN_PREPS.has(m.prep)) || null;
    if (!tout) tout = rest.find((m) => m !== tin) || null;
  } else if (verb === 'sell') {
    tin = unit || rest.find((m) => !OUT_PREPS.has(m.prep)) || null;
    tout = rest.find((m) => m !== tin && OUT_PREPS.has(m.prep)) || rest.find((m) => m !== tin) || null;
  } else {
    tin = unit || rest.find((m) => !OUT_PREPS.has(m.prep)) || null;
    tout = rest.find((m) => m !== tin && OUT_PREPS.has(m.prep)) || rest.find((m) => m !== tin) || null;
  }

  const asks = {};
  const conf = { action: actionConf, amount: 0.2, tokenIn: 0.2, tokenOut: 0.2, slippage: 0.9 };
  const missing = [];
  if (verb === null) missing.push('action');
  let tokenIn = null;
  let tokenOut = null;
  const describe = (m, field) => {
    let c = m.conf;
    if (m.alts.length) {
      c = Math.min(c, 0.4);
      asks[field] = `Which token do you want ${field === 'tokenIn' ? 'to spend' : 'to receive'}: ${[m.sym, ...m.alts].join(' or ')}?`;
    } else if (m.tie) {
      asks[field] = `Did you mean ${m.tie.join(' or ')} for "${m.word}"?`;
    } else if (m.source === 'unknown') {
      asks[field] = `I don't know the token "${m.word}". What is its symbol or contract address?`;
    } else if (m.ask) {
      asks[field] = m.ask;
    }
    if (m.source === 'fuzzy' && !m.tie) assumptions.push(`Read "${m.word}" as ${m.sym}.`);
    if (m.source === 'learned') assumptions.push(`"${m.word}" means ${m.sym} (learned earlier).`);
    if (m.source === 'unknown') assumptions.push(`"${m.word}" is not a known symbol; confirm its contract address from your token list.`);
    if (m.note) assumptions.push(m.note);
    return c;
  };

  if (tin) { tokenIn = tin.sym; conf.tokenIn = describe(tin, 'tokenIn'); }
  if (tout) { tokenOut = tout.sym; conf.tokenOut = describe(tout, 'tokenOut'); }

  // defaults for buy/sell
  if (verb === 'buy' && tout && !tin && tout.sym !== NATIVE) {
    tokenIn = NATIVE;
    conf.tokenIn = 0.7;
    assumptions.push(`Paying with ${NATIVE} (native token) since you did not name a token to spend.`);
  } else if (verb === 'sell' && tin && !tout && tin.sym !== NATIVE) {
    tokenOut = NATIVE;
    conf.tokenOut = 0.7;
    assumptions.push(`Selling for ${NATIVE} (native token) since you did not name a token to receive.`);
  }
  if (!tokenIn) {
    missing.push('tokenIn');
    asks.tokenIn = verb === 'sell' ? 'Which token do you want to sell?' : 'Which token do you want to spend?';
  }
  if (!tokenOut) {
    missing.push('tokenOut');
    asks.tokenOut = `Which token do you want to receive${amtItem && amtItem.amt.value && tokenIn ? ` for ${amtItem.amt.value} ${tokenIn}` : ''}?`;
  }
  const leftover = rest.filter((m) => m !== tin && m !== tout && m.sym !== tokenIn && m.sym !== tokenOut);
  if (leftover.length && tokenIn && tokenOut) {
    conf.tokenOut = Math.min(conf.tokenOut, 0.45);
    asks.tokenOut = `You named more than two tokens (${[tokenIn, tokenOut, ...leftover.map((m) => m.sym)].join(', ')}). Which pair do you want to swap?`;
  }
  let sameToken = false;
  if (tokenIn && tokenOut && tokenIn === tokenOut) {
    sameToken = true;
    conf.tokenIn = Math.min(conf.tokenIn, 0.2);
    conf.tokenOut = Math.min(conf.tokenOut, 0.2);
    asks.tokenOut = `You picked ${tokenIn} on both sides. Which token do you want to receive?`;
  }

  // amount value
  const amountIn = { value: null, unit: null, kind: null };
  if (!amtItem) {
    missing.push('amount');
    asks.amount = `How much ${tokenIn || 'of the token'} do you want to ${verb === 'sell' ? 'sell' : verb === 'buy' ? 'spend' : 'swap'}?`;
  } else {
    const a = amtItem.amt;
    amountIn.kind = a.kind;
    amountIn.value = a.value;
    let c = a.conf;
    if (a.kind === 'usd') {
      amountIn.unit = 'USD';
      assumptions.push(`$${a.value} is converted to a token amount from live quotes; confirm the token amount before sending.`);
    } else if (exactOut) {
      amountIn.unit = tokenOut;
      c = 0.72;
      assumptions.push(`${a.value} is the amount of ${tokenOut} to receive (exact-out), not the amount to spend.`);
    } else if (unit) {
      amountIn.unit = unit.sym;
      if (a.kind === 'exact') c = Math.min(c, 0.95);
    } else {
      amountIn.unit = tokenIn;
      if (tokenIn) {
        const defaulted = conf.tokenIn <= 0.7 && !tin;
        c = Math.min(c, a.kind === 'exact' ? (defaulted ? 0.65 : 0.8) : 0.75);
        assumptions.push(`No unit given; reading the amount as ${tokenIn}.`);
      } else c = Math.min(c, 0.5);
    }
    if (a.kind === 'percent') assumptions.push(`${a.value}% is taken from your ${amountIn.unit || 'token'} balance; read it from chain.`);
    if (a.kind === 'all') assumptions.push(`"All" means your full ${amountIn.unit || 'token'} balance; reserve gas if it is the native token.`);
    if (a.kind !== 'all' && Number(a.value) === 0) {
      c = 0.3;
      asks.amount = 'The amount is zero. How much do you want to swap?';
    }
    if (a.kind === 'percent' && Number(a.value) > 100) {
      c = 0.3;
      asks.amount = `${a.value}% is more than your whole balance. Do you mean a percent from 1 to 100?`;
    }
    if (negative) {
      c = 0.3;
      asks.amount = 'Amounts cannot be negative. How much do you want to swap?';
    }
    if (amtItems.length > 1) {
      c = Math.min(c, 0.45);
      asks.amount = `You gave more than one amount (${amtItems.map((x) => x.amt.value ?? 'all').join(' and ')}). Which one is the amount to spend?`;
    }
    conf.amount = c;
  }

  // slippage
  let slippageBps = ctx.learned.prefs.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const explicit = ctx.slip || (slipItem ? { bps: slipItem.bps, explicit: true, learned: true } : null);
  if (explicit) {
    slippageBps = explicit.bps;
    conf.slippage = explicit.explicit ? 0.95 : 0.8;
    if (!explicit.explicit) assumptions.push(`Reading "max ${slippageBps / 100}%" as the slippage limit.`);
    if (explicit.noUnit) assumptions.push(`No unit after slippage; reading it as ${slippageBps / 100}%.`);
  } else if (ctx.learned.prefs.slippageBps !== undefined) {
    assumptions.push(`Using your saved default slippage of ${slippageBps} bps (${slippageBps / 100}%).`);
    conf.slippage = 0.9;
  } else {
    assumptions.push(`Using default slippage ${DEFAULT_SLIPPAGE_BPS} bps (0.5%).`);
    conf.slippage = 0.9;
  }
  if (slippageBps > 10000) conf.slippage = 0.2;
  else if (slippageBps >= 5000) conf.slippage = 0.4;
  else if (slippageBps > 1000) { conf.slippage = Math.min(conf.slippage, 0.7); assumptions.push(`${slippageBps / 100}% slippage is high; sandwich risk goes up with it.`); }
  else if (slippageBps === 0) { conf.slippage = Math.min(conf.slippage, 0.7); assumptions.push('0 bps slippage reverts on any price movement.'); }
  if (explicit?.noUnit && slippageBps > 1000) {
    // "slippage 50" could be 50 bps or 50%: a 100x misread is too costly to guess.
    conf.slippage = Math.min(conf.slippage, 0.4);
    asks.slippage = `Slippage "${slippageBps / 100}" has no unit. Do you mean ${slippageBps / 100} bps (${slippageBps / 10000}%) or ${slippageBps / 100}%?`;
  }
  if (conf.slippage < ASK_BELOW && !asks.slippage) asks.slippage = `${slippageBps / 100}% slippage is very high. Do you really want ${slippageBps / 100}%, or a lower limit?`;

  // deadline
  let deadlineSec = ctx.deadlineSec;
  if (deadlineSec === null) {
    deadlineSec = DEFAULT_DEADLINE_SEC;
    assumptions.push(`Using default deadline ${DEFAULT_DEADLINE_SEC} s (${DEFAULT_DEADLINE_SEC / 60} min).`);
  } else if (deadlineSec < 30 || deadlineSec > 86400) {
    assumptions.push(`A deadline of ${deadlineSec} s is unusual (normal range 30 s to 24 h); confirm it.`);
  }

  if (ctx.negated) {
    conf.action = Math.min(conf.action, 0.3);
    assumptions.push(`The request contains "${ctx.negated}", which may mean "do not do this" or "cancel"; nothing should be sent until that is cleared up.`);
  }

  for (const k of Object.keys(conf)) conf[k] = round2(Math.max(0, Math.min(1, conf[k])));
  const overall = Math.min(conf.action, conf.amount, conf.tokenIn, conf.tokenOut, conf.slippage);

  // exactly one question when overall < 0.6
  let question = null;
  if (overall < ASK_BELOW) {
    if (ctx.negated) question = `You wrote "${ctx.negated}". Do you want to cancel or not do this, or go ahead with the ${verb || 'request'}?`;
    else if (sameToken) question = asks.tokenOut;
    else {
      const order = ['action', 'tokenIn', 'amount', 'tokenOut', 'slippage'];
      let pick = null;
      for (const f of order) {
        if (conf[f] < ASK_BELOW && (pick === null || conf[f] < conf[pick])) pick = f;
      }
      question = (pick === 'action' ? actionAsk : asks[pick]) || 'Can you rephrase that with an action, an amount and two tokens?';
    }
  }

  return {
    action,
    verb,
    amountIn,
    exactOut,
    tokenIn,
    tokenOut,
    slippageBps,
    deadlineSec,
    confidence: { ...conf, overall: round2(overall) },
    assumptions,
    missing,
    question,
  };
}

/**
 * Parse one human-language request.
 * opts: { learned, tokens } - learned data object, extra token symbols.
 * A sentence holding two requests returns the first one at the top level plus `intents: [...]`.
 */
export function parseIntent(text, opts = {}) {
  const learned = sanitizeLearned(opts?.learned);
  const lex = buildLexicon(learned, opts?.tokens);
  const { s: s0, addrs } = prepare(text);
  const sl = extractSlippage(s0);
  const dl = extractDeadline(sl.s);
  const base = { lex, addrs, learned, slip: sl.slip, deadlineSec: dl.deadlineSec, negated: NEGATION.exec(s0)?.[0] ?? null };

  const clauses = splitClauses(dl.s);
  if (!clauses) return parseClause(dl.s, base);

  let children = clauses.map((c) => parseClause(c, base));
  const first = children.find((c) => c.verb);
  if (first) {
    children = clauses.map((c, i) => (children[i].verb ? children[i] : parseClause(c, { ...base, forceVerb: first.verb })));
  }
  const worst = children.reduce((a, b) => (b.confidence.overall < a.confidence.overall ? b : a));
  const top = { ...children[0] };
  top.assumptions = [...children[0].assumptions, `Found ${children.length} separate requests; handle them one at a time and confirm each before sending.`];
  top.confidence = { ...children[0].confidence, overall: Math.min(...children.map((c) => c.confidence.overall)) };
  top.question = top.confidence.overall < ASK_BELOW ? worst.question : null;
  top.intents = children;
  return top;
}

// ---- CLI -------------------------------------------------------------------------------------
const LEARNED_DIR = '.quai-dex';
const learnedPath = (cwd) => join(cwd, LEARNED_DIR, 'learned.json');

/**
 * Reads the learned store. A missing file is an empty store. A file that exists but cannot be read
 * or parsed (truncated, corrupt) throws an Error with code LEARNED_CORRUPT instead of being treated
 * as empty, so a later save can never wipe earlier learnings.
 */
export function loadLearned(cwd = process.cwd()) {
  let raw;
  try {
    raw = readFileSync(learnedPath(cwd), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return emptyLearned();
    throw corruptError(e);
  }
  try {
    return sanitizeLearned(JSON.parse(raw));
  } catch (e) {
    throw corruptError(e);
  }
}

function corruptError(cause) {
  const err = new Error(`${LEARNED_DIR}/learned.json cannot be read (${cause?.message || cause}). Fix or delete the file; it was not changed.`);
  err.code = 'LEARNED_CORRUPT';
  return err;
}

/** Atomic save: write a temp file next to the target, then rename over it. */
export function saveLearned(learned, cwd = process.cwd()) {
  mkdirSync(join(cwd, LEARNED_DIR), { recursive: true });
  const target = learnedPath(cwd);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(learned, null, 2) + '\n');
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

function usage() {
  console.error([
    'usage:',
    '  node scripts/intent.mjs parse "<text>" [--no-learned]',
    '  node scripts/intent.mjs learn <phrase> <meaning>   meaning: TOKEN | 0xADDRESS | swap|buy|sell|quote|route | bps:N',
    '  node scripts/intent.mjs forget <phrase>',
    '  node scripts/intent.mjs show',
  ].join('\n'));
  return 2;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();
  if (cmd === 'parse') {
    const noLearned = rest.includes('--no-learned');
    const text = rest.filter((a) => a !== '--no-learned').join(' ');
    if (!text.trim()) return usage();
    let learned = emptyLearned();
    let warning = null;
    if (!noLearned) {
      try {
        learned = loadLearned(cwd);
      } catch (e) {
        if (e.code !== 'LEARNED_CORRUPT') throw e;
        warning = `${e.message} Learned phrases were ignored for this parse.`;
        console.error(`warning: ${warning}`);
      }
    }
    const result = parseIntent(text, { learned });
    if (warning) result.assumptions.push(warning);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (cmd === 'learn') {
    if (rest.length < 2) return usage();
    const meaning = rest[rest.length - 1];
    const phrase = rest.slice(0, -1).join(' ');
    try {
      saveLearned(learnPhrase(loadLearned(cwd), phrase, meaning), cwd);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    console.log(JSON.stringify({ ok: true, phrase: normPhrase(phrase), meaning, file: `${LEARNED_DIR}/learned.json` }));
    return 0;
  }
  if (cmd === 'forget') {
    if (rest.length < 1) return usage();
    const phrase = rest.join(' ');
    let before;
    try {
      before = loadLearned(cwd);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    const existed = normPhrase(phrase) in before.aliases || (normPhrase(phrase) === 'default slippage' && before.prefs.slippageBps !== undefined);
    saveLearned(forgetPhrase(before, phrase), cwd);
    console.log(JSON.stringify({ ok: true, phrase: normPhrase(phrase), existed }));
    return 0;
  }
  if (cmd === 'show') {
    try {
      console.log(JSON.stringify(existsSync(learnedPath(cwd)) ? loadLearned(cwd) : emptyLearned(), null, 2));
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    return 0;
  }
  return usage();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
