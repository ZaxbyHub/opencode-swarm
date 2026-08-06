# `fix(security)`: resolve not-yet-existing targets against their nearest existing ancestor in validateSymlinkBoundary

## Summary

- `validateSymlinkBoundary` (`src/utils/path-security.ts`) threw a spurious "Symlink resolution escaped boundary" error whenever the target path did **not exist yet** and the root path sat behind a symlink.
- Root cause: `fs.realpathSync` throws `ENOENT` for a path that has not been created, so the target fell back to `path.resolve` — a purely lexical resolution that leaves symlinks intact. The root, which *does* exist, resolved fully via `realpathSync`. Comparing an unresolved target against a resolved root via `startsWith` is an apples-to-oranges comparison that fails regardless of whether a real boundary violation occurred. This is the symlink analogue of the drive-letter asymmetry fixed previously in the same function; that fix made both fallback branches use `path.resolve` for consistent drive anchoring, but did not address symlinks.
- Fix: both inputs now resolve through a shared `resolveNearestExistingCanonical` helper. It first tries `realpathSync` on the full path (unchanged behavior for paths that exist), and on failure lexically collapses the input, walks up to the nearest **existing** ancestor in a bounded loop, resolves that ancestor's symlinks, and rejoins the not-yet-created tail. Both sides therefore always share a comparison basis.

## User-facing changes

- Repository-graph writes no longer fail on workspaces whose root resolves through a symlink. The canonical case is macOS, where `/tmp` and `/var` are symlinks to `/private/tmp` and `/private/var`, but the same failure applied to symlinked home directories, network mounts, and container bind mounts on any platform. Previously, `getGraphPath` (`src/tools/repo-graph/storage.ts`) and the freshness sidecar's atomic write (`src/tools/repo-graph/freshness.ts`) would refuse to create `.swarm/repo-graph.json` and `.swarm/repo-graph.fingerprint.json` on such a workspace.
- **Newly enforced restriction:** a workspace whose `.swarm/` directory (or any parent component) is itself a symlink pointing *outside* the workspace now correctly fails with a boundary-escape error on first write. Previously this was silently accepted, because the unresolved-target fallback never followed the escaping symlink at all. Any setup relying on that behavior was relying on a containment hole.

## Migration notes

None required.

## Discovery context

Found while investigating why PR #2026 was dropped from the GitHub merge queue: 15 unit-test failures across three `unit (macos-latest, N)` shards, with ubuntu and windows green. The failures reported the asymmetry directly — target `/var/folders/.../.swarm/repo-graph.json` "is not within" root `/private/var/folders/...`.

The bug is **pre-existing** (`validateSymlinkBoundary` and its `getGraphPath` caller are unchanged by PR #2026); that PR merely added two more call sites on not-yet-existing paths (`freshness.ts:158`, `:173`), which widened the failure from one test to fifteen. As with the earlier drive-letter fix, ordinary `pull_request` CI runs only the ubuntu shard — the macOS and Windows shards run on `merge_group` (`.github/workflows/ci.yml:246`) — so the defect was invisible to normal PR validation.

An independent review empirically confirmed both directions on Windows using directory junctions: the reported false rejection is fixed, and the previously-accepted escaping-symlink-with-nonexistent-tail case is now correctly rejected.
