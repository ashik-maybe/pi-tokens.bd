---
name: tokens-bd
description: Use tokens.bd provider features. Check usage before expensive tasks, handle 402/429 gracefully, prefer cheaper models for routine work. Use when working with tokens.bd models or when cost/usage is relevant.
---

# Tokens.bd

## Usage check

Before starting a long or expensive task, run `/tokens-status` to check:
- Wallet balance (top up if < $1).
- Usage window percent (compact if > 90%).
- Key's monthly spend cap.

## Model selection

- Use `/tokens-models` to see available models.
- Use `/tokens-compare` to sort by cost.
- Use `/tokens-suggest` for the cheapest routine model.
- Use `tokens.bd/auto` virtual model for automatic routing (set `PI_ROUTER_LOW` and `PI_ROUTER_HIGH`).

## Error handling

- `insufficient_credits` / `no_funding`: top up or switch to a cheaper model.
- `window_exhausted`: wait for reset or switch models.
- `monthly_spend_cap_exceeded`: use another key or wait.
- `rate_limited`: wait Retry-After seconds.
- `concurrency_limit`: reduce parallelism.

Run `/tokens-errors` for the full reference.

## Codemode recipe

Compose multiple tokens.bd API calls in one script:

```js
const models = await fetch("https://tokens.bd/v1/models", {
  headers: { Authorization: "Bearer " + (await getApiKey()) }
}).then(r => r.json());

const usage = await fetch("https://tokens.bd/v1/tokens/usage", {
  headers: { Authorization: "Bearer " + (await getApiKey()) }
}).then(r => r.json());

return { models: models.data.length, wallet: usage.wallet?.balanceUsd, windows: usage.windows };
```

## Cost awareness

- Set `max_tokens` close to what you need (large values reserve more).
- Prefer cheaper models for routine work (renames, formatting, simple edits).
- Use `/compact` after each phase to reduce context.
- Check `/tokens-history` for spending trends.
- Update `~/.pi/agent/tokens-costs.json` when prices change.
