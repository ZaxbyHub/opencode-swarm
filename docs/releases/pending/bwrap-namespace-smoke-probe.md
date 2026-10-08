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

Both probes now also run a real sandbox: the exact wrap a default-policy
command gets (network off, so `--unshare-net`; user, IPC and PID namespaces;
dropped capabilities; `/proc` and `/dev`; the sized `/tmp` tmpfs; the
`/etc`, `/usr`, `/lib` and `/lib64` read-only binds), running `true`. Its
arguments are built by the same code as every real wrap, so the probe cannot
pass on a host where real wraps fail (for example a host without `/lib64`, or
one that refuses a network namespace):
- if it fails, the executor reports bwrap as unavailable and falls back to
  tool-layer enforcement, with a warning naming the cause;
- the capability probe reports `disabled` with the error.
