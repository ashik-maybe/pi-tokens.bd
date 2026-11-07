# tokens.bd adapter for Pi

Pi provider extension for [tokens.bd](https://tokens.bd). Adds tokens.bd as a native provider with dynamic model catalog, usage widget, and error mapping.

## Install

```bash
pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

Or try without installing:

```bash
pi -e git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

## Setup

1. Create an API key at [tokens.bd/dashboard/keys](https://tokens.bd/dashboard/keys).
2. Run `pi`.
3. `/login tokens.bd` — enter your `tok_live_...` key.
4. `/model` → select a `tokens.bd/` model.
5. `Ctrl+S` to save as default.

The key is stored in `~/.pi/agent/auth.json`. No environment variable needed.
Existing OAuth logins from earlier adapter versions keep working; new logins are stored as standard API-key credentials through Pi's native provider auth.

### Environment variable (alternative)

If you prefer env vars (CI, headless):

```bash
export TOKENS_API_KEY="tok_live_your_key"
pi
```

Pi resolves `$TOKENS_API_KEY` automatically. `/login` takes precedence if both are set.

### models.json (alternative)

If you prefer config over the extension (the extension registers provider `tokens.bd`):

```json
{
  "providers": {
    "tokens": {
      "baseUrl": "https://tokens.bd/v1",
      "api": "openai-completions",
      "apiKey": "$TOKENS_API_KEY",
      "models": [
        { "id": "deepseek/deepseek-v4.1-flash", "input": ["text", "image"] }
      ]
    }
  }
}
```

Place in `~/.pi/agent/models.json`. The extension is not needed in this case.

## Commands

| Command | Description |
|---|---|
| `/tokens-status` | Show plan, usage windows, wallet balance, key limits |
| `/tokens-costs` | Show loaded per-model pricing from tokens-costs.json |
| `/tokens-compare` | Compare available models by cost |
| `/tokens-suggest` | Suggest cheapest model for routine work |
| `/tokens-history` | Show 7-day usage history |
| `/tokens-errors` | List all error codes and fixes |

## Capabilities

- **Text input** default (`input: ["text"]`). Vision/tools vary by model; catalog pages list support, `/v1/models` does not yet expose it.
- **Tool calling** via Pi's built-in OpenAI-compatible handler.
- **Streaming** via Pi's built-in SSE handler.
- **Reasoning** via `reasoning_effort` only on models flagged reasoning in future catalog. Defaults off until `/v1/models` exposes capability.
- **Structured output** via `response_format` (passed through to the provider).

## Footer widget

Shows wallet balance and percent used. Refreshes every 60 seconds.

```
tokens.bd: $12.50 | 26% used
```

Proactive warnings fire when a usage window hits 90% or wallet drops below $1.

## Ladder virtual models

Ladder order lives in `ladder.json`. Pricing stays in `costs.json`.

Extension registers `tokens.bd/fast`, `coder`, `reasoner`, `long-context`, `private`, `research`, plus `auto` as alias to `fast`. Select with `/model`. First physical model in each role list wins. Retry escalates one step down that list.

Retry only escalates retryable quota/5xx errors (`rate_limited`, `rate_limit_exceeded`, `upstream_*`, `model_limit_reached`, context overflow). Auth, billing, spend-cap, and input errors fail fast so a bad key, empty wallet, or malformed request does not burn usage on the rest of the ladder.

Bundled `ladder.json` and `costs.json` ship with the package — no copying needed. Copy `ladder.json` to `~/.pi/agent/tokens-ladder.json` to override. Override one role by env:

```bash
export TOKENS_CODER="id1,id2"
```

## Scoped models (cost efficiency)

Use `/scoped-models` to limit `Ctrl+P` cycling to cheap models. Scope to free models for routine work, switch manually for hard tasks.

## Tokens skill

Ships a `tokens-bd` skill. Pi loads it when cost/usage is relevant. Includes codemode recipes.

## Tokens plan template

Use `/tokens-plan <goal>` for cost-aware task planning.

## Usage history

Usage logged as `tokens-usage` entries in the session branch every 60s. Run `/tokens-history` for session trend. Set `TOKENS_DAILY_BUDGET` to warn on daily spend.

## Update

```bash
pi update
```

Or reinstall:

```bash
pi remove git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

## Uninstall

```bash
pi remove git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

This removes the package declaration from `settings.json`. The extension files are cleaned up by Pi.

## Troubleshooting

### "No models available"

Your key may have an allow-list, or your plan/wallet can't cover any model. Check:
- `GET https://tokens.bd/v1/models` with your key.
- Your plan and wallet on [tokens.bd/dashboard/billing](https://tokens.bd/dashboard/billing).

### "Invalid API key"

- Recopy the key (shown only once at creation).
- Create a new key at [tokens.bd/dashboard/keys](https://tokens.bd/dashboard/keys).
- If using env var, check `echo $TOKENS_API_KEY`.

### Rate limits

- 60 requests per minute (per account, all keys combined).
- Concurrency: 10 with a plan, 3 without.
- Usage windows (5h/weekly/monthly) can block requests with `window_exhausted`.
- Monthly spend cap per key.

See `docs/rate-limits` on tokens.bd for details. Run `/tokens-errors` for the full error code reference.

### 402 / 403 errors

- `insufficient_credits` / `no_funding`: top up or subscribe.
- `monthly_spend_cap_exceeded`: key cap reached, use another key or wait.
- `tier_permission_denied`: plan doesn't include this model, upgrade or add wallet funds.

### Model ignores images or tools

Some models don't support vision or tool calling. The gateway returns a 400 or drops the feature. Check the model's page on [tokens.bd/models](https://tokens.bd/models).

## Per-model costs (optional)

Bundled `costs.json` ships with the package and is used automatically. Copy it to `~/.pi/agent/tokens-costs.json` only to override prices from [tokens.bd/models](https://tokens.bd/models). The adapter loads it on startup and shows per-model cost in Pi's footer and `/session`. Models without cache prices are billed at input price by the gateway; adapter mirrors that.

Copy `ladder.json` from the repo to `~/.pi/agent/tokens-ladder.json` only to override role order.

Update `costs.json` whenever prices change. The file includes a `_note` with the source URL and date.

## Offline catalog

Pi caches the discovered model list in its models store. After one successful fetch, `/model` keeps listing the snapshot offline (`pi --offline`). A failed refresh never wipes the cached catalog.

## Notes

- Pi packages run with your user permissions. Review the source before installing.
- The key is stored in `~/.pi/agent/auth.json`. Never commit it.
- No custom streaming — Pi's built-in SSE handler covers it.
- No hardcoded keys — native auth via `/login`.
- Dynamic model catalog — each key sees only its allowed models.

## Links

- [tokens.bd docs](https://tokens.bd/docs)
- [Pi docs](https://pi.dev/docs)
- [Pi packages](https://pi.dev/packages)
