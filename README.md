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
3. `/login tokens` — enter your `tok_live_...` key.
4. `/model` → select a `tokens/` model.
5. `Ctrl+S` to save as default.

The key is stored in `~/.pi/agent/auth.json`. No environment variable needed.

### Environment variable (alternative)

If you prefer env vars (CI, headless):

```bash
export TOKENS_API_KEY="tok_live_your_key"
pi
```

Pi resolves `$TOKENS_API_KEY` automatically. `/login` takes precedence if both are set.

### models.json (alternative)

If you prefer config over the extension:

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
| `/tokens-models` | List models available to your key |
| `/tokens-errors` | List all error codes and fixes |

## Capabilities

- **Text + image input** on all models (Pi handles errors if a model doesn't support images).
- **Tool calling** via Pi's built-in OpenAI-compatible handler.
- **Streaming** via Pi's built-in SSE handler.
- **Reasoning** via `reasoning_effort` (passed through to the provider).
- **Structured output** via `response_format` (passed through to the provider).

## Footer widget

Shows wallet balance and percent used. Refreshes every 60 seconds.

```
tokens.bd: $12.50 | 26% used
```

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
