# Changelog

## [0.6.0] - 2026-11-11

### Fixed

- `[review]` hint now routes to the monthly reviewer model (`claude-haiku-5-5`) as documented; weekly plans fall back to the balanced pick. Previously it silently behaved as `auto`.

### Removed

- Bundled `costs.json` is dropped. The live `/api/models` catalogue is the sole source of truth. Offline/empty catalogue returns empty costs; price-aware commands print "No costs loaded"/empty results.


### Added

- Typed error classifier parses `error.code` (OpenAI shape) and Anthropic-shaped `code` instead of substring guessing; `model_limit_reached` moved to fail-fast.
- `/tokens-count` via `POST /v1/messages/count_tokens` (not billed) — estimate input size before sizing `max_tokens` or compacting.
- `/tokens-status` shows per-window `remaining`, `percentUsed`, `resetsAt` in human terms; BDT balance stays dashboard-only.
- Early-warning usage alerts at 75/90/100% per window per reset (once per threshold).
- Retry-After seconds (when present) included in ladder fail-fast output and `/tokens-status`/`/tokens-errors` report `x-tokens-request-id`.
- Three providers registered: Tokens.bd (Chat Completions), Tokens.bd Responses, Tokens.bd Messages (`cache_control` passthrough via Anthropic Messages API).
- Tolerant live catalog cache-read/write pricing: cache fields read if present, else billed at input price as before.
- `/tokens-compare` shows cache column; flags always-on thinking models (K3/GLM-5.3).
- `ROLE_THINKING_LEVELS` extended (`xhigh`, `max`); effort superset documented as provider-dependent.
- Forecast projects monthly spend from USD-unit windows only (`/v1/tokens/usage` may report `requests`-unit windows, which carry no price; `session_5h` windows have no monthly projection).
- Consolidated six `tokens-*` commands into one `/tokens <mode>` root (`status|compare|suggest|count|history|errors`); legacy `/tokens-*` names are deprecated shims calling through with once-per-session notice.
- Added experimental optional `tokens.bd/virtual-router` virtual model (opt-in; picks an allowlisted weekly/monthly model per request; sticky on continuations/retries; never auto-switches plans or slabs to premium). Commands: `/tokens router status|plan|mode`.
- Added `/tokens health` — fetches live model catalog and prints counts and costs/context per model.
- Added `/tokens forecast` — projects monthly spend from current window usage and prints wallet USD; usage stays local to the session entry.
- Added `/tokens suggest-all <text>` — expanded pool: picks cheapest affordable model for the prompt using price/context scoring; rule-based, no LLM classifier.
- Added `/tokens models [--cheap] [--limit N]` — lists models with prices; `--cheap` sorts cheapest-first and `--limit` trims output.
- Added `/tokens rank <text>` — top-10 ranked list for the prompt by price/context score.
- Added `/tokens cost <text>` and `/tokens cost --estimate <text>` — cost estimate using cheapest affordable model; no network call for the text path.
- Added `/tokens pin <model-id>` — writes a pinned model to `~/.pi/agent/pinned-model.json`; not auto-applied.
- Added `/tokens explain <text>` — reveals classifier verdict and picked model for a prompt.
- Extended `/tokens forecast` with `--block=<usd>` to print a soft cap latch when projection exceeds the threshold.
- Extended `/tokens models` with `--cheap` (cheapest-first), `--limit N`, and `--count`.
- Extended `/tokens compare` with `--compare-with <text>` to print the 10 cheapest models for that input size.
- Ranked output now tags models as `cheap` vs `premium` (input price threshold crossed at $2/M).
- Added `/tokens history --by-model` — per-model usage count histogram from session entries.
- Extended `/tokens pin` with `--session` to pin only for the current session (not persisted to disk).
- Added `/tokens history --graph` — ASCII sparkline of wallet history derived from session usage entries.
- `/tokens-plan` claim removed (never registered).

### Changed

- Forecast projects monthly spend from USD-unit `weekly`/`monthly` windows only; `requests`-unit windows carry no price, `session_5h` windows have no monthly equivalent. Reports `n/a` when nothing qualifies.
- Wallet stored as `null` (not `0`) when the account has no wallet; `history` prints `n/a` and the graph skips missing points instead of charting `$0`.
- Dropped non-documented `free_limit_reached` code from the error classifier (docs define `window_exhausted`/`model_limit_reached`).
- `no_upstream_available`, `model_not_priced`, `model_not_available` reclassified as non-retryable (docs: pick another model, not backoff).
- Bare `429` without a machine-readable code now fails fast instead of being treated as retryable (could be `window_exhausted`/`model_limit_reached`).
- Pre-flight context guard derives caps from the live catalog instead of hardcoded per-model guesses; 128k fallback when the model is unknown.
- Removed dead exports and locals (`getLastCostSource`, `getLastCostFetchedAt`, `getRetryAfterSeconds`, `getLastCosts`, `packageRootDir`).
- Removed duplicate module-scope shadow of `lastRequestId`; single source now feeds `/tokens-status` and `/tokens-errors`.
- Pre-flight size guard in `before_provider_request`: estimates prompt size (chars/4) against the model's context window; notifies once per 60 s at 80%/95%; never mutates the payload.
- Compact-overflow hint in `session_before_compact` (`reason="overflow"` only): suggests `/tokens-suggest` and `/compact`, never cancels or replaces compaction.

### Docs

- README gains provider-variant notes, one-key-per-customer guidance, migration cheatsheet, BDT note.
- README overhaul — install/upgrade/uninstall, requirements, features, virtual models table, virtual-router hints, consolidated command reference (usage/catalog/recommend/control/diagnostics), dev lanes, known limits trimmed to essentials, dynamic-only catalog pass (no bundled fallback) applied.
- README corrected: removed non-existent low-wallet alert claim; known limits now state catalog prices come from the undocumented `/api/models` feed and that `/v1/models` carries no prices.
- SKILL.md gains count/retry guidance for cached/reasoning sessions and Windows key-export reminder.

## [0.5.0] - 2026-11-10

- Declare host-provided Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) as `peerDependencies` with `"*"` range. Pi supplies them at runtime.
- Point Pi package resources at `./`-prefixed paths; add `./CHANGELOG.md` as the extension changelog.
- Add `files` allow-list for packaging, ship `src/`, `skills/`, `prompts/`, `costs.json`.
- Add `LICENSE` (MIT).
- `pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev` is the supported install path; pin by tag, e.g. `@v0.5.0`.
