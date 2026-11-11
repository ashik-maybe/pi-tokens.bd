# Pi provider for Tokens.bd

One Pi extension that wires [tokens.bd](https://tokens.bd) in as a native provider.
Live catalog, role ladders, optional budget router, usage alerts — kept lean.

## Requirements

- Pi (any recent 1.x). Peer deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`.
- A [tokens.bd](https://tokens.bd) account with a `tok_live_...` API key.
- Network access; catalog and usage are fetched at runtime.

## Install / update / remove

    pi install git:github.com/ashik-maybe/pi-tokens.bd
    pi update git:github.com/ashik-maybe/pi-tokens.bd
    pi remove git:github.com/ashik-maybe/pi-tokens.bd

Or try it in-place without installing:

    pi -e git:github.com/ashik-maybe/pi-tokens.bd

Deleting the clone uninstalls the provider; Pi rescans extensions on next launch.

## Setup

    pi
    /login tokens.bd
    # paste tok_live_...
    /model
    # pick a tokens.bd/<model>
    # Ctrl+S   — save as default

Auth lives in `~/.pi/agent/auth.json`. Never commit it.

Headless / CI alternative:

    export TOKENS_API_KEY="tok_live_..."
    pi

## What ships

- **Three provider variants.** `tokens.bd` (Chat Completions), `tokens.bd-responses` (Responses API), `tokens.bd-messages` (Anthropic Messages). All share one key.
- **Live catalog only.** Pricing and model names are fetched from `https://tokens.bd/api/models` on every launch. Offline, price-aware commands report an empty catalog.
- **Role ladders.** `fast`, `coder`, `reasoner`, `long-context`, `private`, `research` pick the cheapest available model per role and step down on quota/5xx errors. `auto` is an alias to `fast`.
- **Virtual router.** `tokens.bd/virtual-router` is an opt-in, plan-aware assistant. It picks one allowlisted model per task from the current plan and sticks to it on continuations. No plan switching. No premium fallback.
- **Usage alerts.** 75 / 90 / 100% window-count warnings.
- **Error mapping.** Quota/5xx step down ladder; auth, billing, and input errors fail fast.
- **Dynamic catalog helpers.** Price/context-aware suggestions and ranking from your key’s available model set.

## Virtual models

| Model | Behavior |
| --- | --- |
| `tokens.bd/auto` | alias of `fast` |
| `tokens.bd/fast` `coder` `reasoner` `long-context` `private` `research` | price-ordered ladders |
| `tokens.bd/virtual-router` | opt-in, plan-aware router (below) |

Provider variants share the same physical IDs. Pick `tokens.bd-responses/openai/gpt-6-luna` or `tokens.bd-messages/claude-haiku-5-5` to use that endpoint path.

## Virtual router

Select `tokens.bd/virtual-router` from `/model`. Default: weekly plan, auto mode.
Change with the `/tokens router` subcommand:

    /tokens router status
    /tokens router plan weekly     # or monthly
    /tokens router mode auto       # economy|hard

Hints are positional — put them at the start of a message:

| Hint | Result |
| --- | --- |
| `[cheap]` / `[economy]` | smallest affordable model |
| `[balanced]` | default balanced route |
| `[hard]` | strongest allowlisted model (monthly: GLM-5.3; weekly has no hard tier, routes to the balanced coding worker) |
| `[review]` | reviewer-tier (monthly only) |

Env overrides (set before launch):

    TOKENS_ROUTER_PLAN=weekly TOKENS_ROUTER_MODE=economy pi

Rule-based and $0 — no LLM classifier runs.

## Commands

One root: `/tokens <subcommand>`.

### Usage & billing

| Command | Does |
| --- | --- |
| `/tokens status` | Plan, remaining windows, wallet USD, key limits |
| `/tokens forecast [--block=N]` | Projected monthly spend; optional soft cap hint |
| `/tokens history [--graph] [--by-model]` | 7-day sparkline and per-model usage |

### Catalog & pricing

| Command | Does |
| --- | --- |
| `/tokens models [--cheap] [--limit N] [--count]` | Everything your key can call, price-sorted by default |
| `/tokens compare [--compare-with <text>]` | Side-by-side prices or top-10 cheapest cost for an input size |
| `/tokens health` | Live catalog check; reports counts and price/context |
| `/tokens cost <text>` | Token estimate + total cost for the prompt |
| `/tokens count [--model <id>] <text>` | Exact input-token count via the count-tokens endpoint; never billed |

### Recommendations

| Command | Does |
| --- | --- |
| `/tokens suggest` | cheapest affordable default |
| `/tokens suggest-all <text>` | expanded-pool rule-based pick |
| `/tokens rank <text>` | top-10 score list with `[cheap]` / `[premium]` tags |
| `/tokens explain <text>` | prints the model the router picks for the text (same rules as routing) |

### Control

| Command | Does |
| --- | --- |
| `/tokens router status|plan|mode` | virtual-router toggles |
| `/tokens pin <model-id> [--session]` | records a pinned model (nothing applies it; use `/model` to switch) |

### Diagnostics

| Command | Does |
| --- | --- |
| `/tokens errors` | enumerated error codes + quick fixes |

Deprecated shims `/tokens-status`, `/tokens-compare`, etc. still work — they warn once per session and forward to this command surface.

## Development

Source layout:

- `src/index.ts` — wiring only
- `src/catalog.ts` — live catalog, costs, ladder derivation
- `src/router.ts` — virtual router + role router
- `src/dynamic-suggest.ts` — catalog-backed suggestion scoring
- `src/usage.ts` — usage polling, alerts, pre-flight/compaction guards
- `src/commands.ts` — consolidated `/tokens` handler
- `src/errors.ts`, `src/state.ts`, `src/utils.ts`, `src/config.ts` — primitives

Verify before committing:

    ./scripts/verify.sh

(`tsc --noEmit` + offline `--list-models` load smoke test).

## Known limits

- The live catalog is the sole source of truth. If it fails or the key’s model list is empty, price-aware commands print `No costs loaded`/empty results and the ladder/default picks may be empty. Prices come from `https://tokens.bd/api/models`, which is not part of the documented API surface; `GET /v1/models` lists callable ids without prices. If the feed becomes unavailable, there is no price source.
- Recommendations are rule-based; they do not call models and are not latency or quality guarantees.
- `virtual-router` only switch plans via explicit user action and never hands you a premium model by default.
- Tokens.bd does not expose BDT balances/exchange rates; `/tokens status` prints USD only.
- Streaming/tool calling/caching flags are delegated to Pi; the extension does not duplicate them.

## License & docs

MIT — see [`LICENSE`](LICENSE). Changelog lives in [`CHANGELOG.md`](CHANGELOG.md).

- Tokens.bd: <https://tokens.bd> · docs: <https://tokens.bd/docs>
- Pi packages: <https://pi.dev/packages>
