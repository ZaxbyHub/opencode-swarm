# fix(sdd): --source swarm validate returns correct provider and validity

## What changed

`/swarm sdd validate --source swarm` previously fell through to the OpenSpec validation path, building an OpenSpec projection unconditionally and reporting `openspec_projection` as the provider instead of `swarm`. With only a native `.swarm/spec.md` and no OpenSpec, `valid` became `false` even for a perfectly valid swarm spec.

The validate command now has a dedicated native-only branch for `--source swarm` that:
- Calls `loadSddStatusSync` with `source: 'swarm'`
- Filters out OpenSpec-specific errors and warnings
- Returns `provider: 'swarm'` and `valid: true` when the native spec exists and is valid

## Why

The `--source` flag was added to `/swarm sdd status|validate|project` in #1228 (Spec-Kit interop v1), but the validate handler did not route `--source swarm` to a native-only path — it shared the OpenSpec fallback branch, producing incorrect provider and validity results. The status and project handlers already handled `--source swarm` correctly.

## How to use

No API change — `validate --source swarm` now works as documented:

```sh
/swarm sdd validate --source swarm
/swarm sdd validate --source swarm --json
```

## Migration

None — this is a bugfix. The `--source swarm` flag was documented but not correctly implemented in the validate subcommand.

## Known caveats

- The pre-existing `loadSddStatusSync` does not emit an error when a native spec is oversized (>256KiB); it silently returns `effectiveSpec: null`. This is a pre-existing gap, not introduced by this fix.

Closes: #1589
