# tokens.bd adapter for Pi

[Pi](https://pi.dev/) extension for [tokens.bd](https://tokens.bd). Adds tokens.bd as native provider. Dynamic model catalog, usage widget, error mapping.

<details>
<summary>CONTEXT</summary>

This repo is a Pi provider extension. Pi is a terminal coding agent. A provider extension adds one model API to Pi. One model API means one base URL plus auth plus a model list. Source of truth is this repo. Source of truth is the master copy. The AI edits this repo. The AI never commits secrets, keys, or usage logs.

Install steps:

1. Run `pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev`. Manual alternative: clone to `~/Documents/tokens.bd-adapter-for-pi.dev`, then `pi -e` that folder, or copy it to `~/.pi/agent/extensions/`.
2. Create an API key at `tokens.bd/dashboard/keys`.
3. Run `pi`.
4. Run `/login tokens.bd`.
5. Enter the `tok_live_...` key. Key is stored in `~/.pi/agent/auth.json`.
6. Select a `tokens.bd/` model with `/model`.
7. Press `Ctrl+S` to save as default.

Package layout:

1. Pricing comes from `https://tokens.bd/api/models` at startup. `costs.json` is the offline fallback.
2. Ladder order comes from the same live catalog. Ladder means an ordered model list per role. Role means `fast`, `coder`, `reasoner`, `long-context`, `research`. `private` is an alias of `fast`.
3. Override role order only with an explicit `~/.pi/agent/tokens-ladder.json` file, or one role with `TOKENS_<ROLE>` env.
4. Override prices only with Pi `models.json` cost entries, or `~/.pi/agent/tokens-costs.json`.

Commands:

1. `/tokens-status` shows plan, usage windows, wallet, key limits.
2. `/tokens-costs` shows loaded per-model pricing and its source.
3. `/tokens-compare` compares available models by cost.
4. `/tokens-suggest` suggests the cheapest model for routine work.
5. `/tokens-history` shows 7-day usage history.
6. `/tokens-errors` lists error codes and fixes.
7. `/tokens-plan <goal>` plans a task by cost.
8. `/scoped-models` limits model cycling to cheap models.

Rules:

1. The AI never prints the API key.
2. The AI never commits `~/.pi/agent/auth.json`. Auth file means the file with provider credentials.
3. Retry escalates one step down only on quota and 5xx errors. Quota means `rate_limit_exceeded` or `window_exhausted`. 5xx means server-side failures.
4. Auth, billing, spend-cap, and input errors fail fast. Fail fast means stop without trying the next model.
5. First physical model in each role list wins.
6. `auto` is an alias to `fast`.

</details>

## Install

```bash
pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

Pin a released version by tag:

```bash
pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev@v0.5.0
```

Try without installing:

```bash
pi -e git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

## Manual install (no `pi install`)

Use when you want the code in a folder you control, or to edit it live.

```bash
git clone git@github.com:ashik-maybe/tokens.bd-adapter-for-pi.dev.git ~/Documents/tokens.bd-adapter-for-pi.dev
```

Point Pi at the folder. One of these:

```bash
pi -e ~/Documents/tokens.bd-adapter-for-pi.dev   # one session, no settings change
```

Or copy it into Pi's auto-discovered extensions folder (no `-e`, no `settings.json` edit):

```bash
cp -r ~/Documents/tokens.bd-adapter-for-pi.dev ~/.pi/agent/extensions/tokens.bd-adapter-for-pi.dev
```

Then `/login tokens.bd` as usual. Edits take effect on next `pi` start, or immediately with `/reload`.

## Setup

1. Key at [tokens.bd/dashboard/keys](https://tokens.bd/dashboard/keys).
2. `pi`.
3. `/login tokens.bd` — `tok_live_...`.
4. `/model` — pick `tokens.bd/` model.
5. `Ctrl+S` — save default.

Key in `~/.pi/agent/auth.json`. No env var needed. Old OAuth logins keep working; new logins use native API-key auth.

### Env var (alt, CI/headless)

```bash
export TOKENS_API_KEY="tok_live_your_key"
pi
```

Pi reads `$TOKENS_API_KEY`. `/login` wins when both set.

### models.json (alt)

Config instead of extension (extension registers `tokens.bd`):

```json
{
  "providers": {
    "tokens": {
      "baseUrl": "https://tokens.bd/v1",
      "api": "openai-completions",
      "apiKey": "$TOKENS_API_KEY",
      "models": [{ "id": "deepseek/deepseek-v4.1-flash", "input": ["text", "image"] }]
    }
  }
}
```

`~/.pi/agent/models.json`. No extension needed.

## Commands

| Command           | Does                                    |
| ----------------- | --------------------------------------- |
| `/tokens-status`  | Plan, windows with reset clock, wallet, key limits |
| `/tokens-costs`   | Live costs; cache column; source shown |
| `/tokens-compare` | Models by cost; always-on thinking flagged |
| `/tokens-suggest` | Cheapest model, routine work            |
| `/tokens-count`   | Count input_tokens without inference; not billed |
| `/tokens-history` | 7-day usage                             |
| `/tokens-errors`  | Error codes, fixes                      |

## Capabilities

- Text input default (`input: ["text"]`). Vision/tools per model; catalog shows support, `/v1/models` doesn't yet.
- Tool calling: Pi OpenAI-compatible handler.
- Streaming: Pi SSE handler.
- Reasoning: `reasoning_effort` when catalog flags reasoning. Off until `/v1/models` exposes it.
- Structured output: `response_format` passthrough (OpenAI Chat Completions).

### Provider variants

Three providers are registered. Pick `/model` by backend:

- `tokens.bd` — OpenAI Chat Completions (default).
- `tokens.bd-responses` — OpenAI Responses; for tools that want `wire_api = "responses"` (Codex-style).
- `tokens.bd-messages` — Anthropic Messages; `cache_control` reaches the provider, enabling explicit prompt caching on Anthropic-speaking upstreams.

The `/tokens-suggest` command and ladders remain on `tokens.bd`. The variants share the same auth, pricing, catalog and ladder order; only the request format differs.

## Footer widget

Balance + percent. Refresh 60s.

```
tokens.bd: $12.50 | 26% used
```

Warns at 75%, 90%, and 100% of any window (once per reset) and <$1 wallet.

## Ladder

Order: derived from live catalog. Price: `https://tokens.bd/api/models`.

Registers `tokens.bd/fast|coder|reasoner|long-context|private|research` + `auto` (= `fast`). `/model` to pick. First model in list wins. Retry steps down.

Retry only quota/5xx (`rate_limited`, `rate_limit_exceeded`, `upstream_*`, `model_limit_reached`, context overflow). Auth/billing/spend-cap/input fail fast.

Algorithm derives roles at startup. Override: write `~/.pi/agent/tokens-ladder.json`. One role by env:

```bash
export TOKENS_CODER="id1,id2"
```

## Scoped models

`/scoped-models` — `Ctrl+P` cycles cheap models only. Free for routine, manual switch for hard.

## Skill

`tokens-bd` skill ships. Loads on cost/usage topics. Codemode recipes inside.

## Plan template

`/tokens-plan <goal>` — cost-aware task plan.

## Usage history

`tokens-usage` session entries every 60s. `/tokens-history` trend. `TOKENS_DAILY_BUDGET` warns daily spend.

## Update

```bash
pi update
```

Reinstall:

```bash
pi remove git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

## Uninstall

```bash
pi remove git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

Removes `settings.json` declaration. Pi cleans extension files.

## Troubleshooting

### No models

Key allow-list, or plan/wallet covers nothing. Check `GET https://tokens.bd/v1/models` (key) + billing page.

### Invalid key

Recopy (shown once). New key at dashboard. Env var: `echo $TOKENS_API_KEY`.

### Rate limits

60 req/min per account, all keys. Concurrency 10 with plan, 3 without. `window_exhausted` blocks. Monthly spend cap per key. Details: `docs/rate-limits`. `/tokens-errors` full reference.

### 402 / 403

`insufficient_credits` / `no_funding`: top up or subscribe. `monthly_spend_cap_exceeded`: cap hit, other key or wait. `tier_permission_denied`: plan excludes model, upgrade or fund wallet.

### Model ignores images/tools

Model lacks vision/tool support. Gateway 400s or drops feature. Check [tokens.bd/models](https://tokens.bd/models).

## Per-model costs (optional)

Live prices load from `https://tokens.bd/api/models`. Bundled `costs.json` covers offline. Override via Pi `models.json` or `~/.pi/agent/tokens-costs.json` only. Footer + `/session` show cost. No cache price → billed at input price; adapter mirrors.

## Offline catalog

Cache in models store. One fetch → `/model` lists snapshot offline (`pi --offline`). Failed refresh never wipes.

## Auth reuse

All providers share the same `TOKENS_API_KEY`. Auth order: runtime `--api-key` > stored > `auth.json` > env. Pi manages it.

## BDT

Server does not expose BDT balances or exchange rates. `/tokens-status` prints USD only; BDT payer sees final amounts on checkout/dashboard.

## Notes

- Pi packages run with user permissions. Read source before install.
- Key in `~/.pi/agent/auth.json`. Never commit.
- No custom streaming; Pi SSE covers.
- No hardcoded keys; native `/login` auth.
- Dynamic catalog; key sees allowed models only.

## Links

- [tokens.bd docs](https://tokens.bd/docs)
- [Pi packages](https://pi.dev/packages)
- [Changelog](CHANGELOG.md)
