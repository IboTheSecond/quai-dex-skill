# quai-dex-builder

An agent skill for developers building on Quai Network who get stuck on three things:

1. **DEX aggregation**: adapters, net-of-gas route ranking, split routing, slippage and safe sending.
2. **Mobile token lists**: validation, search ranking, virtualised pickers, lazy balances.
3. **Mobile modals**: native `<dialog>` bottom sheets that close properly, handle the keyboard and safe areas.

It also reads plain-language requests ("sell half my qaxe", "buy $20 of HBOME with max 1% slippage"), attaches a confidence score to every field, asks one question when it is not sure, and learns from your corrections.

Works as a Claude Code skill and with any agent that reads `SKILL.md`. Zero runtime dependencies, Node 20 or newer.

## Install

Copy this folder to `~/.claude/skills/quai-dex-builder` (all projects) or `<project>/.claude/skills/quai-dex-builder` (one project). Other agents: point them at `SKILL.md`.

## Quick start

```bash
# read a request
node scripts/intent.mjs parse "swap 10 quai for hbome"

# teach it a correction (stored in ./.quai-dex/learned.json, gitignored)
node scripts/intent.mjs learn hbmoe HBOME
node scripts/intent.mjs parse "swap 10 quai for hbmoe"      # confidence rises to 0.9+
node scripts/intent.mjs forget hbmoe

# rank routes net of gas (see examples/quotes.example.json)
node scripts/route.mjs examples/quotes.example.json

# validate and search a token list
node scripts/tokenlist.mjs validate examples/tokenlist.example.json
node scripts/tokenlist.mjs search examples/tokenlist.example.json exa

npm test
```

## What is inside

| Path | What |
|---|---|
| `SKILL.md` | The skill: steps, thresholds, red flags |
| `scripts/intent.mjs` | `parseIntent`, `learnPhrase`, `forgetPhrase`, CLI |
| `scripts/route.mjs` | `netOut`, `bestRoute`, `evaluateSplit`, `minOut` (BigInt only) |
| `scripts/tokenlist.mjs` | `validateTokenList`, `searchTokens`, CLI |
| `references/` | Quai facts (with sources), aggregation, token lists, mobile modals, confidence and learning |
| `examples/` | Example token list and quotes (EXAMPLE data, not real tokens) |
| `test/` | `node --test` suites |

## Confidence in one paragraph

Every parse returns `confidence` per field and `overall` (the minimum). At 0.85 or above the agent acts; from 0.60 to 0.85 it acts and states its assumptions; below 0.60 it asks exactly one question. Parsing a request never sends anything: real transactions still need a dry run and an explicit confirm.

## Honest limits

- Built-in symbols (QUAI, WQUAI, QI, WQI, HBOME, QAXE) are parsing hints. Token addresses, decimals and venues come from your own lists and contracts.
- Facts that are not sourced (block time, gas price, DEX addresses) are marked UNVERIFIED in `references/quai-facts.md`. Read them from the chain.
- The parser covers common English phrasings of swap, buy, sell, quote and route. When it is unsure it asks; teach it the rest with `learn`.

## License

MIT, Hartii Labs. See `LICENSE`.
