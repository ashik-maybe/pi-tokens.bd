# tokens.bd adapter for Pi

Pi provider extension for [tokens.bd](https://tokens.bd). Adds tokens.bd as a native provider with dynamic model catalog, usage widget, and error mapping.

## Install

```bash
pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev
```

Or local:

```bash
pi install /home/ash/Documents/projects/tokens.bd-adapter-for-pi.dev
```

## Setup

1. Create an API key at [tokens.bd/dashboard/keys](https://tokens.bd/dashboard/keys).
2. Set the env var:
   ```bash
   export TOKENS_API_KEY="tok_live_your_key"
   ```
3. Run `pi`, then `/login tokens` (or the key is picked up from env automatically).
4. `/model` → select a `tokens/` model.
5. Press `Ctrl+S` to save as default.

## Commands

- `/tokens-status` — plan, usage windows, wallet balance, key limits.
- `/tokens-errors` — list error codes and fixes.

## Footer widget

Shows wallet balance and percent used. Refreshes every 60s.

## Capabilities

All models advertise text + image input. Tool calling and streaming use Pi's built-in OpenAI-compatible handler.

## Notes

- No hardcoded keys. Uses env var or `auth.json`.
- No custom streaming. Pi's built-in SSE handler covers it.
- Models are fetched dynamically from `GET /v1/models`. Each key sees only its allowed models.
- Rate limits: 60 RPM per account, concurrency 10 (with plan) / 3 (without).
- Backoff: start 1s, double, jitter, cap 30s, max 5 attempts.

## Links

- [tokens.bd docs](https://tokens.bd/docs)
- [Pi docs](https://pi.dev/docs)
