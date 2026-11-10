---
name: tokens-bd
description: Use tokens.bd provider features in Pi. When working with tokens.bd models (or Pi jobs touching tokens.bd), check usage before expensive tasks, count tokens before sizing, prefer cheaper ladder roles, handle 402/429 with the right retry policy, and preserve prompt-cache prefixes. Use for cost-sensitive model calls, rate-limited runs, broken responses, oversized contexts, or anything that surfaces spend.
---

# Tokens.bd

Bundled with the provider extension. Trigger it for cost-sensitive or error-triage work.

## Count first, act later

Input-token counting is exact and not billed. Use it before sizing `max_tokens` or checking context fit.

```text
/tokens count --model <id> <text>
```

`--model <id>` may be space-separated or `--model=<id>`; omitted `--model` infers the current model from the registry or catalog. Text caps at 8000 chars. Counts go through `POST /v1/messages/count_tokens`. Do it before compacting when at 75% of a window.

## Check usage before long jobs

- `/tokens status` — plan, windows, wallet, key limits. Fires no requests beyond the usage endpoint.
- `/tokens compare` — pricing incl. cache columns, always-on thinking models flagged, source marked live/file/fallback.
- `/tokens suggest` — cheapest routine model from the live catalog (falls back to `costs.json`).
- `/tokens history` — 7-day usage. `/tokens errors` — error code reference with fixes.
- Pre-flight guard fires at 80%/95% of the context window once per 60 s; if it trips, run `/tokens count --model <id> <text>` and compact or switch to a cheaper/larger-context role.
- Live alerts at 75/90/100% fire once per window per reset. Do not wait for 429s.

## Model selection

- Use `/model` to list available models. `/tokens-models` was removed; Pi `/model` covers it.
- Ladder roles map to `tokens.bd/<role>`: `fast`, `coder`, `reasoner`, `long-context`, `private` (alias of `fast`), `research`, and `auto`.
- Ladder order derives from the live `/v1/models` catalog at startup. `~/.pi/agent/tokens-ladder.json` or `TOKENS_<ROLE>=m1,m2` override the order.
- Prices come from `https://tokens.bd/api/models` at startup; `costs.json` is the offline fallback. Pin a price with `~/.pi/agent/tokens-costs.json`, not by editing `costs.json`.

## Error handling

| Family | Codes | Policy |
|---|---|---|
| 402 — billing | `insufficient_credits`, `no_funding`, `outstanding_debt`, `member_cap_reached`, `402` | Stop. No retry. Top up or switch model. |
| 429 — usage windows | `window_exhausted`, `model_limit_reached` | Stop and wait for reset (`/tokens status`) or switch model. Do **not** loop. |
| 429 — transient | `rate_limited`, `rate_limit_exceeded`, `concurrency_limit` | Wait `Retry-After` seconds + jitter. Reduce parallelism. |
| 403 — key cap | `monthly_spend_cap_exceeded` | Another key or wait. |
| 401/400/404 | `invalid_api_key`, `model_not_allowed_on_key`, `model_not_found` | Fix request; retrying only burns budget. |
| 5xx | gateway/provider errors | Backoff, max 4 tries, cap 30 s. Gateway already failed over for multi-provider models. |
| context | `context_length_exceeded` | Compact, switch to `long-context`, or trim. |

- Retry is a new request; there is no idempotency key. Retried streams bill the whole prompt again.
- Retry-After is the only rate-limit header; no `X-RateLimit-*` headers exist. Always read the code first.
- Log `x-tokens-request-id` on success and failure; it's the support key.
- In a loop, treat 401/402/403/413 as fatal — surface and ask.

## Cost awareness

- Set `max_tokens` close to the expected answer — the reservation uses `max_tokens`, and wide limits can be refused near a key cap or with a thin balance.
- Prefer cheaper roles for routine work (renames, formatting, simple edits).
- Keep tool definitions and system prompt byte-identical and first; variable parts last (order: tools → system → messages). That is what the provider's automatic caching needs, and what `cache_control` breakpoints on Messages rely on.
- Cache lives on the upstream provider. Verify a cache hit with two sequential identical-prefix calls; check `cache_read_input_tokens` (Messages) or `prompt_tokens_details.cached_tokens` / `cached_tokens` (Chat).
- Short prompts (below the provider minimum) never cache. Cached-prefix requests still reserve worst-case cost against the balance; a big stable prefix can be refused with a low wallet even if the real cost would be small.
- Use `/compact` when the pre-flight guard or 90% alert fires.

## Windows env var

```powershell
setx TOKENS_API_KEY "tok_live_…"
```

## What this skill does not do

- Key management, plan/changes, payment, teams, referrals, usage alerts emails — dashboard only.
- Billing display is not shipped; /tokens outputs used/remaining tokens + percent, not BDT or FX.
- Sending images is supported (vision); a dedicated vision helper is not.
