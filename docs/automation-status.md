# Automation status artifact (optional)

When `automation.mode` is set to a non-manual value (`hybrid` or `auto`) in
`.opencode/opencode-swarm.json`, the plugin writes a passive status snapshot
to `.swarm/automation-status.json` for GUI visibility. This page documents
that artifact's operational contract.

## The artifact is optional

- **Nothing in the plugin depends on it.** No production code reads
  `automation-status.json`; it exists purely for external/GUI visibility.
  The write is registered on the plugin's post-resolution task queue (issue
  #2669), so it runs only after the plugin manifest has been delivered and
  its latency or failure can never block plugin registration.
- **A missing artifact is not a plugin load failure.** If the file is absent,
  the plugin is still fully loaded with all agents and tools. Do not
  diagnose a "plugin not available" problem by looking at this file — a
  genuine plugin init failure prints a `[opencode-swarm] FATAL: plugin
  initialization failed.` banner, which the status artifact can never cause.
- The default (`manual`) mode never writes the artifact at all.

## Bounded failure categories

All persistence failures are contained inside the writer: no mutator throws,
the in-memory snapshot still advances, and exactly one bounded, debug-gated
diagnostic line is emitted (`status artifact write failed (non-fatal)` with
an `operation`, `category`, and `code` — no raw paths or stack traces). The
categories are:

| Category | Typical errno codes | Meaning |
| --- | --- | --- |
| `dir_conflict` | `EEXIST`, `ENOTDIR` | `.swarm` exists but is not a usable directory (e.g. a regular file occupies the path) |
| `path_is_directory` | `EISDIR` | `automation-status.json` exists as a directory |
| `permission` | `EACCES`, `EPERM`, `EBUSY` | The directory or file is not writable / locked |
| `volume` | `EROFS`, `ENOSPC` | Read-only or full volume |
| `missing_path` | `ENOENT` | A path component disappeared (or the artifact path traverses a non-directory on Windows) |
| `unknown` | anything else | Un-mapped platform-specific codes (expected fallback, e.g. some Windows error codes) |

Failures never trigger repair passes or network work; the next successful
mutator call simply rewrites the artifact.

The table above covers the error-raising classes. Two further notes on file
integrity: a write that fails mid-way (e.g. `volume`) can leave a truncated
file on disk until the next successful write replaces it, and writes are not
locked or atomic, so two processes writing simultaneously could in principle
interleave — a torn file parses as absent on the next read and heals on the
next successful write, and neither case can affect the plugin itself.

## Diagnosing a missing status artifact

1. Run once with `OPENCODE_SWARM_DEBUG=1` and reproduce the state
   (e.g. start the host in the project). Look for
   `status artifact write failed (non-fatal)` — the `category`/`code` fields
   identify the class of failure per the table above.
2. Check the filesystem facts for that category: is `.swarm` a regular file?
   Is `automation-status.json` a directory? Is the volume read-only or full?
3. Fix the filesystem condition (remove/rename the conflicting path, restore
   write permission) and trigger any automation status update — the artifact
   reappears without restarting the plugin.
4. If the plugin itself seems missing (no agents/tools in the host), that is
   a separate problem from this artifact: look for the FATAL banner or the
   host's plugin logs instead. The status artifact cannot cause it.
