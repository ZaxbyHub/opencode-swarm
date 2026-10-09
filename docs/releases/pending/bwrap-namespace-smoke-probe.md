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

Known limit: the probe checks the host once, with the default policy, so it
always includes the network namespace (`network_mode: off`, the default). On a
host that allows user namespaces but refuses network namespaces (typically a
nested container), bwrap is reported unavailable even for a configuration with
`network_mode: on`, whose real wraps would not need one.

Known limit: the result is cached for the life of the process, like the
executor and capability results it feeds. A smoke run that fails once — for
example by hitting its 5-second timeout on a briefly overloaded host — keeps
bwrap reported unavailable until OpenCode restarts. With
`guardrails.sandbox.mode: advisory` (the default) shell commands then run on
tool-layer enforcement only, with one warning; with `required` they are
blocked until the restart.
