# Pi extension for Tokens.bd

Pi extension. Adds [tokens.bd](https://tokens.bd) as a native provider. Dynamic catalog, usage widget, error mapping, optional router.

## Requirements

- Pi (any recent 1.x). peer deps: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
- Tokens.bd account (api key starts `tok_live_`)
- Network access

## Install

    pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Pin a tag:

    pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev@v0.5.0

Try without keeping:

    pi -e git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Uninstall:

    pi remove git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev

Or delete the cloned/copied folder. Pi auto-discovery rescans on next start.

## Setup

    pi
    /login tokens.bd
    <paste tok_live_ key>
    /model
    <pick tokens.bd/<model>>
    <ctrl+s>  # save as default

Key lives in `~/.pi/agent/auth.json`. Never commit it.

Headless alt:

    export TOKENS_API_KEY="tok_live_..."
    pi

## Features

- Auto catalog. Live pricing + model list on startup. Falls back to bundled `costs.json` offline.
- Three provider variants. `tokens.bd` (chat completions) — `tokens.bd-responses` — `tokens.bd-messages`. Share the same key.
- Role ladders. Alias models: `fast`, `coder`, `reasoner`, `long-context`, `private`, `research` — auto-rotated to cheapest available.
- Virtual router. `tokens.bd/virtual-router` is opt-in and optional. Routes to the cheapest suitable allowlisted model for the current plan. Sticky on continuations; switches back at task boundary only.
- Usage alerts. Panel on window consumption ≥75%, 90%, 100% and wallet <$1.
- Retry safety. Quota / 5xx steps down ladder. Auth, billing, spend-cap, input errors fail fast.

## Virtual models registered

| Model | Effect |
| --- | --- |
| `tokens.bd/auto` | alias of `fast` |
| `tokens.bd/fast` `coder` `reasoner` `long-context` `private` `research` | role ladders, price-ordered |
| `tokens.bd/virtual-router` | opt-in budget router (see below) |

Provider variants reuse the same physical ids. Pick `tokens.bd-messages/claude-haiku-5-5` to use the Messages endpoint, for example.

## Budget router

Select `tokens.bd/virtual-router` from `/model`. Defaults: weekly plan, auto mode. `/tokens router` subcommand toggles:

    /tokens router status
    /tokens router plan weekly     # or monthly
    /tokens router mode auto       # economy|hard also accepted

Hints are positional: `[hard]` at the start of a message routes to the hard tier; `[cheap]` to the economy tier. Plain prompts land on the default balanced route. Reads `TOKENS_ROUTER_PLAN` and `TOKENS_ROUTER_MODE` env vars if set before launch.

## Commands

| Command | Does |
| --- | --- |
| `/tokens` | help / default `/tokens status` |
| `/tokens status` | plan, remaining windows, wallet, key limits |
| `/tokens compare` | models by cost; cache column; thinking shown |
| `/tokens suggest` | cheapest routine model |
| `/tokens suggest-all [text]` | expanded pool: cheapest affordable model for the prompt |
| `/tokens rank <text>` | top-10 list for the prompt, context-aware score |
| `/tokens models` | all models the key can call, with price/context |
| `/tokens count [--model <id>] <text>` | count prompt tokens; not billed |
| `/tokens history` | 7-day trend |
| `/tokens errors` | codes + fixes |
| `/tokens health` | live catalog check; reports count + price context |
| `/tokens forecast` | projected monthly spend |
| `/tokens router status|plan|mode` | budget router toggles |

Deprecated shims `/tokens-status`, `/tokens-compare`, etc. are still accepted; they warn once per session and call through.

## Development

Source under `src/`. Wiring in `index.ts`. Lane layout:

- `src/index.ts` wires providers, virtual models, hooks
- `src/router.ts` budget router and role router
- `src/catalog.ts` catalog fetch + cache
- `src/usage.ts` windows, alerts, pre-flight guard
- `src/commands.ts` `/tokens *`
- `src/errors.ts` error classifier

Verify: `scripts/verify.sh` = `tsc --noEmit` plus a live `pi --list-models` check.

## Known limits

- Costs taken from live catalog at startup; bundled `costs.json` is fallback only.
- Pi's `/login` is the auth path. `TOKENS_API_KEY` only when Pi can't open `/login`.
- No BDT figures; `tokens.bd/status` shows USD only.
- No auto-switch between weekly and monthly plans; router respects the plan you set.
- Streaming and tools are handled by Pi, not duplicated here.

## Links

- [tokens.bd](https://tokens.bd) · [docs](https://tokens.bd/docs)
- [pi packages](https://pi.dev/packages)
- Changelog in [`CHANGELOG.md`](CHANGELOG.md)
