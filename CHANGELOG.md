# Changelog

## [Unreleased]

### Added

- Typed error classifier parses `error.code` (OpenAI shape) and Anthropic-shaped `code` instead of substring guessing; new `free_limit_reached` mapped; `model_limit_reached` moved to fail-fast.
- `/tokens-count` via `POST /v1/messages/count_tokens` (not billed) — estimate input size before sizing `max_tokens` or compacting.
- `/tokens-status` shows per-window `remaining`, `percentUsed`, `resetsAt` in human terms; BDT balance stays dashboard-only.
- Early-warning usage alerts at 75/90/100% per window per reset (once per threshold).
- Retry-After seconds (when present) included in ladder fail-fast output and `/tokens-status`/`/tokens-errors` report `x-tokens-request-id`.
- Three providers registered: Tokens.bd (Chat Completions), Tokens.bd Responses, Tokens.bd Messages (`cache_control` passthrough via Anthropic Messages API).
- Tolerant live catalog cache-read/write pricing: cache fields read if present, else billed at input price as before.
- `/tokens-compare` shows cache column; flags always-on thinking models (K3/GLM-5.3).
- `ROLE_THINKING_LEVELS` extended (`xhigh`, `max`); effort superset documented as provider-dependent.
- `/tokens compare` prints `Source: <live|bundled>` so readers see whether prices came from live fetch or bundled fallback (no separate `/tokens-costs` command).
- Consolidated six `tokens-*` commands into one `/tokens <mode>` root (`status|compare|suggest|count|history|errors`); legacy `/tokens-*` names are deprecated shims calling through with once-per-session notice.
- `/tokens-plan` claim removed (never registered).

### Changed

- Removed duplicate module-scope shadow of `lastRequestId`; single source now feeds `/tokens-status` and `/tokens-errors`.
- Pre-flight size guard in `before_provider_request`: estimates prompt size (chars/4) against the model's context window; notifies once per 60 s at 80%/95%; never mutates the payload.
- Compact-overflow hint in `session_before_compact` (`reason="overflow"` only): suggests `/tokens-suggest` and `/compact`, never cancels or replaces compaction.

### Docs

- README gains provider-variant notes, one-key-per-customer guidance, migration cheatsheet, BDT note.
- SKILL.md gains count/retry guidance for cached/reasoning sessions and Windows key-export reminder.

## [0.5.0] - 2026-11-10

- Declare host-provided Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) as `peerDependencies` with `"*"` range. Pi supplies them at runtime.
- Point Pi package resources at `./`-prefixed paths; add `./CHANGELOG.md` as the extension changelog.
- Add `files` allow-list for packaging, ship `src/`, `skills/`, `prompts/`, `costs.json`.
- Add `LICENSE` (MIT).
- `pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev` is the supported install path; pin by tag, e.g. `@v0.5.0`.
