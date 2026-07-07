# Lean Turbo worktree isolation now enabled by default

## What

Aligns `turbo.lean.worktree_isolation` default with the general surface
`worktree.policy: 'auto'` (engaged by default).

## Before

`turbo.lean.worktree_isolation` defaulted to `false`. Users had to opt
in by setting it explicitly.

## After

`turbo.lean.worktree_isolation` defaults to `true`. Lean Turbo phases
now provision per-lane worktrees by default, matching the general
surface behavior. Users can opt out by setting
`turbo.lean.worktree_isolation: false` explicitly.

## Migration

No action required for users who:
- Already set `turbo.lean.worktree_isolation: true` (no behavior change)
- Use the default for the general surface (consistency restored)

Users who want to KEEP the old behavior must now opt out explicitly:
```json
{
  "turbo": {
    "strategy": "lean",
    "lean": {
      "worktree_isolation": false
    }
  }
}
```

## Related

- Closes part of #1226 (Phase 0 hardening)
- See also: FR-107 / SC-121 in `.swarm/spec.md`
