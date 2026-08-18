## Fix: CLI-invoked mode commands now receive a correct `packageRoot`

### What changed

`run()` in `src/cli/index.ts` now resolves a `PACKAGE_ROOT` constant and passes
it as `packageRoot` in the `CommandContext` given to command handlers.
Previously `packageRoot` was omitted entirely.

The resolution walks up **two** directory levels from the module
(`path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')`),
because the CLI entry point is one level deeper than the main plugin entry:
the CLI builds to `<root>/dist/cli/index.js` and runs from
`<root>/src/cli/index.ts` in dev, whereas `src/index.ts` builds to
`<root>/dist/index.js`. This matches the existing `resolvePackageRoot`
(`src/commands/gate-audit.ts`) and `resolvePackageRootFromModule`
(`src/commands/memory.ts`) helpers, which both special-case a `cli`/`commands`
leaf with two `'..'`.

### Why

When mode commands (e.g. brainstorm) are invoked from the CLI instead of the
plugin chat interface, the `syncBundledProjectSkillsIfMissingAsync` backstop in
`handleModeCommandWithBundledSkills` (`src/commands/registry.ts`) was skipped
because `ctx.packageRoot` was `undefined`. The backstop now runs against the
real package root, so it can find the bundled-skill source tree at
`<packageRoot>/.opencode/skills`.

A single-level resolution would have been worse than the original bug: it would
point at `<root>/dist` (or `<root>/src`), where the sync would silently find no
source skills and no-op, while also overriding `gate-audit`'s correct
`DEFAULT_PACKAGE_ROOT` with a path that hard-throws `ENOENT`.

### Testing

`tests/unit/cli/package-root-resolution.test.ts` pins the arity: it derives the
level count from the shipped source expression and asserts the result is the
real package root from both the dev (`src/cli`) and built (`dist/cli`)
locations, including the presence of `.opencode/skills`.

### Migration

No migration required.
