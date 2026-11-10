# Changelog

## [0.5.0] - 2026-11-10

- Declare host-provided Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) as `peerDependencies` with `"*"` range. Pi supplies them at runtime.
- Point Pi package resources at `./`-prefixed paths; add `./CHANGELOG.md` as the extension changelog.
- Add `files` allow-list for packaging, ship `src/`, `skills/`, `prompts/`, `costs.json`.
- Add `LICENSE` (MIT).
- `pi install git:github.com/ashik-maybe/tokens.bd-adapter-for-pi.dev` is the supported install path; pin by tag, e.g. `@v0.5.0`.
