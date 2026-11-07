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

- Use `/model` to see available models. `/tokens-models` was removed; Pi `/model` covers it.
- Use `/tokens-compare` to sort by cost.
- Use `/tokens-suggest` for the cheapest routine model.
- Use `tokens.bd/<role>` ladder virtual models for routing:
  `fast`, `coder`, `reasoner`, `long-context`, `private`, `research`, and `auto` (alias to fast).
- Ladder order lives in `ladder.json`; pricing stays in `costs.json`.
- Env override per role: `TOKENS_FAST=m1,m2`, `TOKENS_CODER=m1,m2`. Copy `ladder.json` to `~/.pi/agent/tokens-ladder.json` to override.

## Error handling

- `insufficient_credits` / `no_funding`: top up or switch to a cheaper model.
- `window_exhausted`: wait for reset or switch models.
- `monthly_spend_cap_exceeded`: use another key or wait.
- `rate_limited`: wait Retry-After seconds.
- `concurrency_limit`: reduce parallelism.

Run `/tokens-errors` for the full reference.

## Cost awareness

- Set `max_tokens` close to what you need (large values reserve more).
- Prefer cheaper models for routine work (renames, formatting, simple edits).
- Use `/compact` after each phase to reduce context.
- Check `/tokens-history` for spending trends.
- Update `~/.pi/agent/tokens-costs.json` when prices change.
- Keep global config stable for prompt cache reuse.
