# Confidence and learning

`scripts/intent.mjs` turns plain language into a structured request and says how sure it is. The same discipline applies to your own technical claims.

## 1. Thresholds
| Overall confidence | What to do |
|---|---|
| >= 0.85 | Act. |
| 0.60 to < 0.85 | Act, and state the assumption in one line ("Reading 'hbmoe' as HBOME"). |
| < 0.60 | Ask exactly one focused question (the parser returns it in `question`). Do not guess. |

`overall` is the minimum of the field scores (`action`, `amount`, `tokenIn`, `tokenOut`, `slippage`). One weak field makes the whole request weak. `question` is non-null exactly when `overall < 0.60`. Reading a request never means sending one: any transaction still needs a dry run and an explicit user confirm.

## 2. Scoring rules (as implemented)
| Situation | Score |
|---|---|
| Exact verb (`swap`, `buy`, `sell`, ...) | 0.97 |
| "how much ...", "what would I get ..." phrase | 0.90 |
| `get` as the only verb | 0.75 |
| Verb with one typo (edit distance 1, length >= 4) | 0.80 |
| No verb, but an amount and two tokens | 0.65 (read as a swap) |
| No verb recognisable | 0.20 |
| Known symbol, any casing | 0.97 |
| Valid Cyprus-1 shaped address (`0x00` + 40 hex total) | 0.95 |
| Address in another zone | 0.60 |
| Qi-shaped or malformed address | 0.30 |
| Typo token, unique nearest match (distance 1) | 0.74 (length >= 5), 0.70 (4), 0.62 (3) |
| Typo token, distance 2 (length >= 6) | 0.60 |
| Typo token with two equally near candidates | 0.40 and the question names both |
| Unknown ticker-looking word in a token slot | 0.45 |
| "A or B" for the same slot | 0.40 and the question names both |
| Same token on both sides | 0.20 |
| Token defaulted (buy pays in QUAI, sell receives QUAI) | 0.70 and stated |
| Exact amount with its unit token | 0.95 (word numbers 0.90) |
| Exact amount without a unit | 0.80, or 0.65 when the token was also defaulted |
| Percent / all with the token named | 0.92 (max 0.85) |
| USD amount | 0.85, token amount is derived from quotes and must be confirmed |
| Exact-out ("buy 500 HBOME") | 0.72 and stated |
| Two amounts in one request | 0.45 |
| Zero amount | 0.30 |
| Slippage given | 0.95; default 50 bps 0.90 (stated) |
| Slippage above 10% / above 50% / above 100% | 0.70 / 0.40 (asks) / 0.20 |

Compound sentences ("buy X with 500 and Y with 500") return the first request on top and every request in `intents`. Handle them one at a time and confirm each.

## 3. Rate your own technical claims
- High: you read the code or queried the chain in this session.
- Medium: from official docs, cite the page.
- Low: inferred. Label it "(inferred)" and say how to check it.
Never present a low claim as a fact. A number you did not measure (block time, gas price, pool depth) is read at runtime or marked UNVERIFIED.

## 4. Learning from corrections
The user corrects you in plain words ("no, hbmoe means HBOME", "by 'tight' I mean 0.3%", "yeet is swap"). Record it immediately:
```
node scripts/intent.mjs learn hbmoe HBOME
node scripts/intent.mjs learn tight bps:30
node scripts/intent.mjs learn yeet swap
node scripts/intent.mjs learn "default slippage" bps:100
node scripts/intent.mjs forget hbmoe
```
Meaning is a token symbol, a `0x` address, an action (`swap|buy|sell|quote|route`) or `bps:N`. Multi-word phrases work. Add a one-line entry to `LEARNINGS.md` in the user's project (date, what was misread, what is right) so a human can audit it.

At the start of each session read `.quai-dex/learned.json` and `LEARNINGS.md`. `parseIntent(text, { learned })` and the CLI (which loads the file from the current directory) both apply it.

## 5. learned.json format
```json
{
  "version": 1,
  "aliases": {
    "hbmoe": { "kind": "token", "meaning": "HBOME", "count": 1, "updated": "2026-01-01T00:00:00.000Z" },
    "yeet":  { "kind": "action", "meaning": "swap", "count": 1, "updated": "..." },
    "tight": { "kind": "bps", "meaning": 30, "count": 1, "updated": "..." }
  },
  "prefs": { "slippageBps": 100 },
  "history": [ { "at": "...", "op": "learn", "phrase": "hbmoe", "meaning": "HBOME" } ]
}
```
- Keys are lowercase phrases. A learned phrase wins over built-in matching, including fuzzy guesses.
- Learned phrases score >= 0.90 (token and action 0.95). A saved default slippage scores 0.90 and is stated as "your saved default".
- `history` keeps the last 100 operations; `aliases` is capped at 500.
- The folder `.quai-dex/` is gitignored by default: it is per-user preference data, not project source.

## 6. How a correction changes the next parse
Before: `swap 10 quai for hbmoe` -> tokenOut HBOME at 0.74, assumption "Read 'hbmoe' as HBOME", overall 0.74.
After `learn hbmoe HBOME`: tokenOut HBOME at 0.95, no typo assumption, overall 0.90.
A wrong correction is fixed by `learn` again with the right meaning (it overwrites) or `forget`.
Never repeat a mistake the user already corrected: check learned data first, then parse.
