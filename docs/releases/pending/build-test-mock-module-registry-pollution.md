# Fix cross-file `mock.module` pollution in `tests/unit/build/`

## What

`tests/unit/build/discovery-profiles.test.ts` and
`tests/unit/build/discovery-profiles-adversarial.test.ts` replaced
`src/lang/detector` and `src/lang/profiles` via `mock.module` with **partial**
objects — `LANGUAGE_REGISTRY` was mocked with a `get` method and nothing else.

Both mocks now follow the AGENTS.md invariant 7 spread-real-exports pattern, the
shared scaffolding moved to `tests/unit/build/discovery-profiles-mocks.ts`, and a
local-only regression guard was added at
`tests/unit/build/zz-imports-plugin-entry.test.ts`.

## Why

`mock.module` leaks process-wide in Bun's shared test-runner. Because these two
mocks did not spread the real module's exports, **any** test file placed in
`tests/unit/build/` that transitively imported `src/index.ts` crashed at
module-evaluation time:

```
TypeError: LANGUAGE_REGISTRY.getAll is not a function
    at src/tools/repo-graph/builder.ts  (module scope)
```

`src/tools/repo-graph/builder.ts` computes `SUPPORTED_EXTENSIONS` from
`LANGUAGE_REGISTRY.getAll()` at module scope, so the partial mock turned a
sibling file's import into a hard failure. The affected file passed in isolation
and failed only when the directory was run as a whole, which makes the trap easy
to misdiagnose as a bug in the new test.

This was hit while implementing #2029 and worked around at the time by
relocating the new test out of `tests/unit/build/` entirely. The underlying trap
remained for the next author; this change removes it.

## Notable detail — a plain spread would not have fixed it

`LANGUAGE_REGISTRY` is an instance of the `LanguageRegistry` class
(`src/lang/profiles.ts`), so `get`, `getAll`, `getByExtension`, and the rest live
on the prototype. `{ ...realProfiles.LANGUAGE_REGISTRY, get: mockGet }` copies
only own enumerable properties and would silently drop every method, leaving the
mock just as partial as before.

The mocks instead derive from the real singleton, via
`deriveMockedRegistry` in `tests/unit/build/discovery-profiles-mocks.ts`
(schematic — see the helper for the exact generic signature):

```ts
const derived = Object.create(realRegistry) as R;
derived.get = ((...args: Parameters<R['get']>) => mockGet(...args)) as R['get'];
```

Prototype lookup keeps every real method and the instance's private `Map`s
reachable, and the own-property `get` override never mutates the real singleton.

Caveat for future edits: do not call the registry's mutators (`register`,
`unregister`) through the derived object — `this.profiles` resolves up the
prototype chain to the **real** singleton's `Map` and would pollute it globally.
Neither test file does so today, and the caveat is repeated as a doc comment on
`deriveMockedRegistry` itself so it is visible at the point of use.

### Why the `mock.module` calls stayed in the test files

The shared helper holds only the fixture type and the registry derivation. The
literal `mock.module('../../../src/lang/detector', …)` /
`('../../../src/lang/profiles', …)` calls deliberately remain in each
`*.test.ts`, because `scripts/check-mock-cleanup.sh` and
`scripts/generate-mock-allowlist.sh` both discover mocks with
`grep -r --include="*.test.ts"`. Hoisting those calls into a non-test helper
would have hidden both targets (`scripts/mock-allowlist.txt:93-94`) from the
very gates that police this defect class — trading a real guardrail for tidier
files.

## Migration

No migration required. Test-only change; no runtime or public API surface is
affected.

## Known caveats

`tests/unit/build/zz-imports-plugin-entry.test.ts` is a **local-only** guard, and
the label matters: CI (`scripts/ci/run-unit-tests-local.ts`) runs every test file
in its own process, so the sibling mocks are never installed alongside it and it
passes trivially there. It bites only on a shared-process run such as
`bun test tests/unit/build/` — which is exactly how the defect was found. It is
also inert under `bun test --randomize`, which can schedule it before the
`discovery-*` mocks install. Both limits are documented in the file's docstring;
neither is a defect, but a green CI run is not evidence the guard fired.

`scripts/check-mock-cleanup.sh` still reports 14 pre-existing non-spreading
`mock.module` violations elsewhere in the repository (currently warning-only,
outside the scope of this change).
