---
name: tokens-bd
description: Use tokens.bd provider features. Check usage before expensive tasks, handle 402/429 gracefully, prefer cheaper models for routine work. Use when working with tokens.bd models or when cost/usage is relevant.
---

# Tokens.bd

## Count first, act later

`/tokens count --model <id> <text>` counts input tokens for a payload without running inference. It never bills; do it before sizing `max_tokens`, checking context fit, and compacting when at 75% of a 5-hour window.

Usage check:
- Run `/tokens status` before long tasks.
- Watch `--model` virtual ladder pick; auto-escalates on 429/5xx within one step and escalates to the next ladder model on Retry-After hints.
- Remaining/percentUsed/resetsAt show next reset time in plain text.
- Live 90%/100% alerts fire once per window per reset, before a failure.
- Pre-flight guard in `before_provider_request` warns at 80%/95% of context once per 60 s. If it fires, use `/tokens count --model <id> <text>` for the exact count (not billed).

```bash
setx TOKENS_API_KEY "tok_live_..."
```


## Model selection

- Use `/model` to see available models. `/tokens-models` was removed; Pi `/model` covers it.
- Use `/tokens compare` to sort by cost.
- Use `/tokens suggest` for the cheapest routine model.
- Use `tokens.bd/<role>` ladder virtual models for routing:
  `fast`, `coder`, `reasoner`, `long-context`, `private`, `research`, and `auto` (alias to fast).
- Ladder order derives from the live catalog at startup; pricing comes from `https://tokens.bd/api/models` (`costs.json` is the offline fallback).
- Env override per role: `TOKENS_FAST=m1,m2`, `TOKENS_CODER=m1,m2`. Write `~/.pi/agent/tokens-ladder.json` to override fully.

## Error handling

Typed codes parsed from `error.code` (OpenAI shape) or the Anthropic-shaped `code` field (Messages). Best-effort status digits; known 402-style billing errors fail fast; transient 429/5xx map to /try-another-model notes with Retry-After.

- `insufficient_credits` / `no_funding`: top up or switch to a cheaper model. Retries would only burn usage.
- `window_exhausted` / `free_limit_reached`: wait for reset (`/tokens status`) or upgrade; do not loop on 429.
- `monthly_spend_cap_exceeded`: another key or wait.
- `rate_limited`: wait `Retry-After`; tool flow reduces parallelism.
- `concurrency_limit`: wait 2 s or cap concurrency.
- `/tokens status` and `/tokens errors` include the last `x-tokens-request-id` for support tickets.

Run `/tokens errors` for the full reference.

## Cost awareness

- Set `max_tokens` close to what you need (large values reserve more).
- Prefer cheaper models for routine work (renames, formatting, simple edits).
- Use `/compact` after each phase to reduce context.
- Check `/tokens history` for spending trends.
- Prices refresh automatically on startup. Edit `~/.pi/agent/tokens-costs.json` only to pin a price.
- Keep stable global config for prompt cache reuse. See Prompt caching doc for prefix placement; breakpoints follow Anthropic rules.
