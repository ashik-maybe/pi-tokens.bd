# Pi provider for Tokens.bd

One Pi extension that adds [tokens.bd](https://tokens.bd) as a native provider.
Live catalog, role ladders, optional budget router, usage alerts — all wiring
wired in minimal module lanes.

## Requirements

- Pi (any recent 1.x). Peer deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`.
- A [tokens.bd](https://tokens.bd) account with a `tok_live_...` API key.
- Network access for the live model catalog and your key’s usage window.

## Install

    pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Pin a tag:

    pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev@v0.5.0

Try without keeping it:

    pi -e git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Update:

    pi update git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Uninstall:

    pi remove git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Or delete the clone. Pi rescans extensions on next launch, so no restart magic is needed.

## Setup

    pi
    /login tokens.bd
    # paste tok_live_...
    /model
    # pick a tokens.bd/<model>
    # Ctrl+S   — save as default

The key is stored in `~/.pi/agent/auth.json`. Never commit it to a repo.

Headless/CI alternative:

    export TOKENS_API_KEY="tok_live_..."
    pi

## What ships

- **Three provider variants.** `tokens.bd` (Chat Completions), `tokens.bd-responses` (Responses API), `tokens.bd-messages` (Anthropic Messages, piped through for tool-style workflows). All share the same key.
- **Live catalog.** Pricing and model list are fetched on startup from `https://tokens.bd/api/models`. No bundled fallback: offline/empty catalogue means expensive commands show "No costs loaded" and the ladder falls through to empty defaults.
- **Role ladders.** `fast`, `coder`, `reasoner`, `long-context`, `private`, `research` pick the cheapest available model per role and step down on quota/5xx errors. `auto` is an alias to `fast`.
- **Virtual router.** `tokens.bd/virtual-router` is an opt-in, plan-aware assistant. It picks one model per task from a narrow weekly/monthly allowlist and sticks to it on continuations. No auto-switch between plans. No premium fallback.
- **Usage alerts.** 75/90/100% window-count warnings, plus a low-wallet alert below $1.
- **Error mapping.** Quota/5xx step down the ladder; auth, billing, and input errors fail fast.
- **Dynamic catalog tools.** Price/context-aware suggestions and ranking for budget-conscious users — see the `/tokens` commands below.

## Virtual models

| Model | Behavior |
| --- | --- |
| `tokens.bd/auto` | alias of `fast` |
| `tokens.bd/fast` `coder` `reasoner` `long-context` `private` `research` | price-ordered ladders |
| `tokens.bd/virtual-router` | opt-in budget router (below) |

Provider variants reuse the same physical model IDs. Pick
`tokens.bd-responses/gpt-6-luna` or `tokens.bd-messages/claude-haiku-5-5` to use
the corresponding endpoint flavor.

## Virtual router

Select `tokens.bd/virtual-router` from `/model`. Default: weekly plan, auto mode.
Change with the `/tokens router` subcommand:

    /tokens router status
    /tokens router plan weekly     # or monthly
    /tokens router mode auto       # economy|hard

Hints at the start of a message pick a tier:

| Hint | Result |
| --- | --- |
| `[cheap]` / `[economy]` | smallest affordable model |
| `[balanced]` | default balanced route |
| `[hard]` | strongest allowlisted model for the current plan |
| `[review]` | reviewer-tier (monthly only) |

Env overrides (set before launch):

    TOKENS_ROUTER_PLAN=weekly TOKENS_ROUTER_MODE=economy pi

The router reads your usage window and wallet, but it never fires an LLM call to decide — it’s rule-based, $0 classifier.

## Commands

All under one root: `/tokens <subcommand>`.

### Usage & billing

| Command | Does |
| --- | --- |
| `/tokens status` | Plan, remaining windows, wallet USD, key limits |
| `/tokens forecast [--block=N]` | Projected monthly spend; optional soft cap |
| `/tokens history [--graph] [--by-model]` | 7‑day spend sparkline and frequency per model |

### Catalog & pricing

| Command | Does |
| --- | --- |
| `/tokens models [--cheap] [--limit N] [--count]` | What your key can call, sorted by price by default |
| `/tokens compare [--compare-with <text>]` | Side-by-side prices; with text, top-10 cheapest cost for that input size |
| `/tokens health` | Live catalog check; reports count and per‑model cost/context |
| `/tokens cost <text>` | Token estimate + total cost for the prompt |
| `/tokens count [--model <id>] <text>` | Exact input-token count via the count-tokens endpoint; never billed |

### Recommendations

| Command | Does |
| --- | --- |
| `/tokens suggest` | cheapest affordable default |
| `/tokens suggest-all <text>` | expanded pool, rule-based pick |
| `/tokens rank <text>` | top-10 scoring list (adds `[cheap]`/`[premium]` tags) |
| `/tokens explain <text>` | prints why the classifier picked the suggested model |

### Control

| Command | Does |
| --- | --- |
| `/tokens router status\|plan\|mode` | virtual‑router toggles |
| `/tokens pin <model-id> [--session]` | pin a model locally; `--session` keeps it for this session only |

### Diagnostics

| Command | Does |
| --- | --- |
| `/tokens errors` | enumerated error codes + quick fixes |

Deprecated shims `/tokens-status`, `/tokens-compare`, etc. still work — they warn once per session and forward to the consolidated command.

## Development

Source tree (trim for the gist, not exhaustive):

- `src/index.ts` — wiring only
- `src/catalog.ts` — live catalog, costs, ladder derivation
- `src/router.ts` — virtual router + role router
- `src/dynamic-suggest.ts` — catalog-backed suggestion scoring
- `src/usage.ts` — usage polling, alerts, pre‑flight guard
- `src/commands.ts` — consolidated `/tokens` handler
- `src/errors.ts` — error-code classifier
- `src/errors.ts`, `src/state.ts`, `src/utils.ts`, `src/config.ts` — primitives

Verify before committing:

    ./scripts/verify.sh

which is `tsc --noEmit` plus a load-time `--list-models` smoke test.

## Known limits

- No bundled fallback remains. If the catalog fetch fails or your key returns an empty model list, price-aware commands (`/tokens models`, `/tokens compare`, `/tokens cost`) will show empty results and the ladder/default picks may be empty. Retry after the network/catalog recovers.
- `/tokens` recommendations are rule-based; they do not call models and are neither latency nor quality guarantees.
- `virtual-router` sticks to its allowlist on continuations and only switches on explicit user action (hint or task boundary); it never auto‑escalates to a premium tier.
- `/tokens` BDT balances aren’t surfaced — USD only; full figures live on the dashboard.
- The router scores from the catalog and the key’s allow-list; it does not know your inbox or session budget unless you opt in with `--block`.
- Streaming, tool calling, and protocol specifics (SSE, `cache_control`, etc.) are delegated to Pi.

## License & docs

MIT — see [`LICENSE`](LICENSE). Changelog lives in [`CHANGELOG.md`](CHANGELOG.md).

- Tokens.bd: <https://tokens.bd> · docs: <https://tokens.bd/docs>
- Pi packages: <https://pi.dev/packages>
