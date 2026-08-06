# Fix cross-file `mock.module` pollution in `tests/unit/build/`

## What

`tests/unit/build/discovery-profiles.test.ts` and
`tests/unit/build/discovery-profiles-adversarial.test.ts` replaced
`src/lang/detector` and `src/lang/profiles` via `mock.module` with **partial**
objects — `LANGUAGE_REGISTRY` was mocked with a `get` method and nothing else.

Both mocks now follow the AGENTS.md invariant 7 spread-real-exports pattern, and
a permanent regression guard was added at
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

The mocks instead derive from the real singleton:

```ts
const mockedLanguageRegistry = Object.create(
	realProfiles.LANGUAGE_REGISTRY,
) as typeof realProfiles.LANGUAGE_REGISTRY;
mockedLanguageRegistry.get = (...args) => mockLangRegistryGet(...args);
```

Prototype lookup keeps every real method and the instance's private `Map`s
reachable, and the own-property `get` override never mutates the real singleton.

Caveat for future edits: do not call the registry's mutators (`register`,
`unregister`) through the derived object — `this.profiles` resolves up the
prototype chain to the **real** singleton's `Map` and would pollute it globally.
Neither test file does so today.

## Migration

No migration required. Test-only change; no runtime or public API surface is
affected.

## Known caveats

`tests/unit/build/zz-imports-plugin-entry.test.ts` relies on filename sort order
so that it imports `src/index.ts` *after* the sibling mocks install. The `zz-`
prefix is load-bearing; a guard that sorts before `discovery-*` would be inert.
This is documented in the file's own docstring.

`scripts/check-mock-cleanup.sh` still reports 14 pre-existing non-spreading
`mock.module` violations elsewhere in the repository (currently warning-only,
outside the scope of this change).
