# Fix: macOS sandbox profile embeds kernel-resolved system paths

## What changed

The macOS `sandbox-exec` executor now embeds the kernel-resolved form of scope paths and the temp dir (production and probe profile) for the three macOS system links: `/tmp`, `/var` and `/etc` are rewritten to `/private/tmp`, `/private/var` and `/private/etc`, but only when this host's `realpath` confirms the link.

The rewrite is a prefix swap on the input string. No other symlink is ever followed, so a link created inside a project can neither change the result nor widen the profile to its target; any other path, a host without the link, or an error leaves the path as written, which Seatbelt never matches (as before).

Seatbelt matches `subpath` against the kernel-resolved path. With a symlinked prefix the scoped `(allow file-write* (subpath …))` line never matched, so every in-scope write was denied while the profile looked correct. Verified with raw `sandbox-exec`: the `/tmp/…` form exits 1 (`Operation not permitted`), the `/private/tmp/…` form exits 0. A visible symptom: the plugin's own capability probe reported `filesystem: weak` on macOS because its in-scope write was denied; it now reports `real`.

## Why

Closes #3462. Sibling of #2590 / PR #2630 (invalid `setenv` in the same profile).
