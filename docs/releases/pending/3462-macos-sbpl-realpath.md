# Fix: macOS sandbox profile embeds kernel-resolved system paths

## What changed

The macOS `sandbox-exec` profile builder now writes the kernel-resolved form of a path when it starts with one of the three macOS system links: `/tmp`, `/var` and `/etc` become `/private/tmp`, `/private/var` and `/private/etc`. The rewrite applies to scope paths and to the temp dir, in both the production and the probe profile, and only when this host's `realpath` confirms the link.

The rewrite is a prefix swap on the input string. No other symlink is ever followed, so a link created inside a project can neither change the result nor widen the profile to its target. A path that is already resolved is used as it is. A path under any other symlink (for example `~/projects -> /Volumes/data`), a host without the link, or an error leaves the path exactly as written (the previous behaviour): that path stays unmatched by Seatbelt and writes to it are denied.

Seatbelt matches `subpath` against the kernel-resolved path. Before this change a scoped `(allow file-write* (subpath "/var/…"))` line never matched, so the allow was inert while the profile looked correct. Verified with raw `sandbox-exec`: the `/tmp/…` form exits 1 (`Operation not permitted`), the `/private/tmp/…` form exits 0.

The wrapped command now passes the profile inline (`sandbox-exec -p '<profile>' bash -c …`) instead of staging it in a file under the temp dir. The temp dir is inside the write grant (see below), so a staged profile there could be rewritten by a still-running sandboxed process before a later call's `sandbox-exec` read it; with no file there is nothing to race, and no per-call profile files accumulate in the temp dir any more.

## Behaviour changes you may notice (macOS, `guardrails.sandbox_macos_enabled: true`)

- **The temp-dir write grant is now effective.** Every wrapped command has always been given write access to `os.tmpdir()`. On macOS that is the per-user `$TMPDIR` (`/var/folders/<xx>/<yyyy>/T`), which sits under the `/var` link, so the grant never matched and temp writes were denied. It now matches: wrapped commands can write anywhere under `$TMPDIR`, including files other processes of the same user keep there. The grant is a whole-temp-tree allowance, not one scratch directory per command, and it is wider than the per-run temp of the Linux executor (`--tmpfs`) and of the Windows native runner (a per-run `temp_root`); the Windows PowerShell wrapper has no OS-enforced write containment.
- **The capability probe reports `filesystem: real`.** The probe's own in-scope write used to be denied, so it reported `weak` on macOS. It now reports `real`.
- **`guardrails.sandbox.mode: required` can now enforce.** With `guardrails.sandbox.require_filesystem: true` the probe's `weak` made required mode block every shell command on macOS. With `real` it can proceed, but only when `guardrails.sandbox.network_mode: on` is also set and `guardrails.sandbox.network_allowlist` is empty: macOS reports `network_mode: off` as unsupported, so the default `off` is still blocked. `guardrails.sandbox.require_network` and `guardrails.sandbox.require_process` stay blocked because macOS reports no real containment for them. Advisory mode and `require_filesystem: false` are unchanged.
- **Scope paths.** Paths that exist are already resolved by the scope resolver, and a not-yet-existing path under a symlinked root is rejected as a traversal. In normal tool use the rewrite therefore mostly affects the temp dir and the probe; it matters directly for callers that build a profile from a `/tmp`, `/var` or `/etc` path.

## Why

Closes #3462. Sibling of #2590 / PR #2630 (invalid `setenv` in the same profile).

## Known caveats

- The sandbox stays opt-in (`sandbox_macos_enabled` defaults to `false`).
- Windows and Linux are unaffected.
- Other symlinked roots are not rewritten by the profile builder; a path under one stays unresolved and Seatbelt does not match it (writes denied).
