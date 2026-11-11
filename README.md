# pi-tokens.bd

One Pi extension that wires [tokens.bd](https://tokens.bd) in as a native provider.
Live catalog pricing, role ladders, an opt-in plan-aware router, usage alerts.

## Requirements

- Pi 1.x with peer deps `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.
- A [tokens.bd](https://tokens.bd) account and a `tok_live_...` key (<https://tokens.bd/dashboard/keys>).
- Network access. Catalog and usage are fetched at runtime; offline behavior is degraded but non-crashing.

## Install

    pi install npm:pi-tokens.bd

(Updating later: `pi update npm:pi-tokens.bd`. GitHub install also works: `pi install git:github.com/ashik-maybe/pi-tokens.bd`.)

First run:

    pi
    /login tokens.bd          # paste tok_live_... — stored by Pi, never commit it
    /model tokens.bd/z-ai/glm-5.3-flash
    /tokens status            # plan, windows, wallet

To make a model the default, add `"defaultModel": "tokens.bd/<model-id>"` to `~/.pi/agent/settings.json`.

Try without installing:

    pi -e npm:pi-tokens.bd

## Uninstall

1. `pi remove git:github.com/ashik-maybe/pi-tokens.bd`
2. `/logout` inside Pi (or delete the `tokens.bd` entry from `~/.pi/agent/auth.json`)
3. Remove `TOKENS_API_KEY` from your shell profile, if you set one

Upgrading from ≤0.5.0: the bundled skill, prompts and `costs.json` were dropped in 0.6.0 — you get the extension only. Pricing comes from the live catalog; offline commands report `No costs loaded`.

## Usage

### Authentication

Two ways in, either works:

- Interactive: `/login tokens.bd` — Pi stores the key in `~/.pi/agent/auth.json`.
- Headless / CI: `export TOKENS_API_KEY="tok_live_..."` before launching pi.

The extension asks Pi for the stored key first, then falls back to `TOKENS_API_KEY`. Keys must start with `tok_live_`; anything else is rejected at `/login`.

### Picking a model

    /model tokens.bd/z-ai/glm-5.3-flash

Three provider variants share one key. Pick by wire protocol:

| Provider | Endpoint | Use when |
| --- | --- | --- |
| `tokens.bd` | `https://tokens.bd/v1/chat/completions` | default |
| `tokens.bd-responses` | `https://tokens.bd/v1/responses` | you need the Responses API |
| `tokens.bd-messages` | `https://tokens.bd/v1/messages` | you need Anthropic Messages |

Provider variants share the same physical model ids: `tokens.bd-responses/openai/gpt-6-luna`, `tokens.bd-messages/claude-haiku-5-5`, etc. On endpoints a model cannot serve, the gateway returns `endpoint_not_supported_for_model` / `anthropic_protocol_disabled`.

Streaming, tool calling and prompt caching are delegated to Pi; the extension does not duplicate them.

### Role ladders

Price-ordered ladders. `/model tokens.bd/<role>` picks the cheapest viable model for the role and steps down on quota (`429`) and 5xx errors; auth, billing and input errors fail fast.

| Model | Behavior |
| --- | --- |
| `tokens.bd/auto` | alias of `fast` |
| `tokens.bd/fast` `coder` `reasoner` `long-context` `private` `research` | cheapest viable pick per role, key allowlist applied |

### Virtual router

An opt-in, plan-aware assistant. Select `tokens.bd/virtual-router` from `/model`. It picks one allowlisted model per task from the current plan (default: weekly, auto) and sticks to it on continuations. No plan switching, no premium fallback. Rule-based and $0 — no LLM classifier runs.

    /tokens router status
    /tokens router plan weekly     # or monthly
    /tokens router mode auto       # economy|hard

Positional hints at the start of a message:

| Hint | Result |
| --- | --- |
| `[cheap]` / `[economy]` | smallest affordable model |
| `[balanced]` | default balanced route |
| `[hard]` | strongest allowlisted model (monthly: GLM-5.3; weekly has no hard tier — routes to the balanced coding worker) |
| `[review]` | reviewer-tier (monthly only) |

### `/tokens` commands

Usage & billing:

| Command | Does |
| --- | --- |
| `/tokens status` | Plan, remaining windows, wallet USD, key limits |
| `/tokens forecast [--block=N]` | Projected monthly spend; optional soft cap hint |
| `/tokens history [--graph] [--by-model]` | 7-day sparkline and per-model usage (session only) |

Catalog & pricing:

| Command | Does |
| --- | --- |
| `/tokens models [--cheap] [--limit N] [--count]` | Everything your key can call, price-sorted by default |
| `/tokens compare [--compare-with <text>]` | Side-by-side prices, or top-10 cheapest cost for an input size |
| `/tokens health` | Live catalog check; reports counts and price/context |
| `/tokens cost <text>` | Token estimate + total cost for the prompt |
| `/tokens count [--model <id>] <text>` | Exact input-token count via count-tokens; never billed |

Recommendations (rule-based, no model calls):

| Command | Does |
| --- | --- |
| `/tokens suggest` | Cheapest affordable default |
| `/tokens suggest-all <text>` | Expanded-pool rule-based pick |
| `/tokens rank <text>` | Top-10 list with `[cheap]` / `[premium]` tags |
| `/tokens explain <text>` | Prints the model the router picks (same rules as routing) |

Control & diagnostics:

| Command | Does |
| --- | --- |
| `/tokens router status\|plan\|mode` | virtual-router toggles |
| `/tokens errors` | Enumerated error codes + quick fixes |

Deprecated shims `/tokens-status`, `/tokens-compare`, etc. still work — they warn once per session and forward to this command surface.

### Usage alerts

The footer shows the current window. The extension additionally polls usage every 60 s and warns at 75 / 90 / 100% of a window. Alerts may lag a burst by up to a minute; nothing is persisted until the numbers change.

## Configuration

Ladder roles are derived from the live catalog on every launch (cheapest viable picks). Two overrides, in order of precedence — algorithm → file → env:

1. File: `~/.pi/agent/tokens-ladder.json`

   { "roles": { "fast": ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash"] } }

   (`roles` wrapper optional — a bare `{ "fast": [...] }` works too.)

2. Env (wins over the file): `TOKENS_FAST`, `TOKENS_CODER`, `TOKENS_REASONER`, `TOKENS_LONG_CONTEXT`, `TOKENS_PRIVATE`, `TOKENS_RESEARCH` — comma-separated ids.

   TOKENS_FAST="z-ai/glm-5.3-flash,qwen/qwen-3.8-27b" pi

Env-listed ids are used as-is; the catalog is not consulted for them.

| Variable | Used for |
| --- | --- |
| `TOKENS_API_KEY` | API key when Pi has no stored `tokens.bd` credential |
| `TOKENS_ROUTER_PLAN` | `weekly` (default) or `monthly` for virtual-router |
| `TOKENS_ROUTER_MODE` | `auto` (default), `economy`, `hard` for virtual-router |
| `TOKENS_FAST` … `TOKENS_RESEARCH` | Ladder overrides (comma-separated ids) |

## Known limits

- The live catalog (`https://tokens.bd/api/models`, not part of the documented API surface) is the sole source of pricing. If it fails or your key’s model list is empty, price-aware commands print `No costs loaded`/empty results and ladder picks may be empty. `GET /v1/models` lists callable ids without prices as a fallback.
- Recommendations are rule-based; they do not call models and are not latency or quality guarantees.
- All catalog models register as text-only — vision models are not usable through this provider. Reasoning flags are inferred from id patterns (`glm-5.3*`, `kimi-k3*`); other reasoning-capable models show up as non-reasoning.
- All models register into all three wire protocols; endpoints a model can’t serve return `endpoint_not_supported_for_model` / `anthropic_protocol_disabled`.
- `virtual-router` never switches plans; `[hard]` on weekly routes to the balanced tier.
- Usage windows are polled every 60 s; alerts can lag a burst by up to a minute.
- Tokens.bd does not expose BDT balances/exchange rates; `/tokens status` prints USD only.

## Development

Code is commented as the dev documentation — see the module headers and inline notes in `src/`. Source layout: `src/index.ts` (wiring), `src/catalog.ts` (catalog, costs, ladder), `src/router.ts` (virtual + role router), `src/dynamic-suggest.ts` (suggestion scoring), `src/usage.ts` (usage polling, alerts), `src/commands.ts` (`/tokens` handler), `src/errors.ts`, `src/state.ts`, `src/utils.ts`, `src/config.ts`.

Verify before committing:

    ./scripts/verify.sh

(`tsc --noEmit` + offline `--list-models` load smoke test.)

## License & docs

MIT — see [`LICENSE`](LICENSE). Changelog: [`CHANGELOG.md`](CHANGELOG.md).

- Tokens.bd: <https://tokens.bd> · docs: <https://tokens.bd/docs>
