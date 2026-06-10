# Auto-build `dist/` on source installs via a `prepare` script

## What changed

Added a `prepare` lifecycle script (`"prepare": "bun run build"`) to `package.json`
so that `dist/` is built automatically whenever the package is installed **from
source** — a local checkout (`bun install` / `npm install`) or a git/GitHub
reference (`npm i github:zaxbysauce/opencode-swarm`). The now-redundant
`prepublishOnly` build hook was removed (`prepare` already builds before
`pack`/`publish`). `scripts/package-smoke.mjs` was hardened to tolerate the build
output that `npm pack` now prints ahead of its `--json` payload. Documented in
`contributing.md` that loading the plugin from a checkout requires a build, and that
`bun install` now performs it.

## Why

After #1047 stopped committing generated `dist/`, the plugin's entry point
(`package.json#main` → `dist/index.js`) no longer existed in a fresh checkout, and
nothing rebuilt it: `prepublishOnly` only runs on `npm publish`, and there was no
`prepare`/`postinstall` hook. As a result, anyone running the plugin **from source**
(maintainers' local instances, contributors, git-ref installs) found the plugin
failed to load until they manually ran `bun run build`. The npm **registry** package
was unaffected — the publish workflow builds and validates `dist/` before publishing —
so this was a source/checkout regression, not a published-package break.

`prepare` is the standard lifecycle hook for "don't commit build output, build from
source on install." It runs for local and git installs but **not** when consumers
install the prebuilt registry tarball (which already contains `dist/`), so registry
installs are unchanged.

## Migration / notes

- Running from a source checkout: `bun install` now builds `dist/` for you. After a
  `git pull` that changes source without changing dependencies, run `bun run build`
  (or `bun run dev`) to refresh the bundle before loading the plugin.
- Cross-platform: the hook only calls `bun run build`, whose chain (`clean` via
  `fs.rmSync`, `copy-grammars`, `bun build`, `tsc`) contains no OS-specific commands;
  it is exercised on ubuntu/macOS/windows by the existing `unit`/`package-check`/
  `smoke` CI matrices.
- CI installs (`bun install --frozen-lockfile`) in this repo build `dist/` via
  `prepare`. Lifecycle scripts run for a package's own install and for npm
  git-reference installs; Bun does not run them for dependencies unless the consumer
  lists the package in `trustedDependencies`, so a Bun consumer adding this as a git
  dependency must trust it (or run `bun run build`). Registry installs need none of
  this — the tarball already contains `dist/`.
- `prepare` also runs during `npm pack`/`npm publish` when lifecycle scripts are
  enabled, so its build progress can be printed to stdout ahead of the
  `npm pack --json` payload. `scripts/package-smoke.mjs` therefore extracts the JSON
  array from the combined output rather than assuming stdout is pure JSON; this is
  robust whether or not `prepare` emits build noise, keeping the `package-check` CI
  job and the publish job's artifact validation working across npm versions.
