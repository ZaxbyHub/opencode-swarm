# Fix: Linux sandbox detection runs a real bwrap sandbox, not just `--version`

## What

Both Bubblewrap probes treated a working `bwrap --version` as a usable
sandbox:
- the executor's `probeBwrap`;
- the capability probe's `probeLinux`.

On hosts that restrict unprivileged user namespaces, `--version` succeeds but
every real invocation fails with `setting up uid map: Permission denied`.
Ubuntu 24.04 and later do this by default
(`kernel.apparmor_restrict_unprivileged_userns=1`). The plugin reported a
strong sandbox there, and every sandboxed command failed.

Both probes now also run the smallest real sandbox, using the same kernel
features as a real wrap (user, IPC and PID namespaces, dropped capabilities,
`/proc` and `/dev` mounts, then `true`):
- if it fails, the executor reports bwrap as unavailable and falls back to
  tool-layer enforcement, with a warning naming the cause;
- the capability probe reports `disabled` with the error.
