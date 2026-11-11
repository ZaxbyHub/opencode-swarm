# Bubblewrap sandbox: /tmp tmpfs no longer shadows scope binds

## What changed

- `buildBwrapArgs` (`src/sandbox/linux/bubblewrap-executor.ts`) now mounts the
  `/tmp` tmpfs before the scope `--bind` arguments. bwrap applies mounts in
  argument order, so a scope path under the temp directory was previously
  shadowed by the empty tmpfs and writes into it failed. The argument order is
  now: read-only roots, `/tmp` tmpfs, scope binds, then the remaining system
  mounts.
- `tests/unit/sandbox/sandbox-integration.test.ts` AC-010 uses a writable temp
  directory as its broad scope instead of `/home`. On runners where `/home` is
  root-owned, the write was denied by the filesystem, so the test measured host
  permissions rather than the sandbox.

## Why

On the `ubuntu-latest` runner image (Ubuntu 26.04), `bwrap` is installed, so the
Linux legs of `sandbox-integration.test.ts` run for the first time. The previous
image (24.04) had no `bwrap`, so those legs returned early and passed without
asserting anything. Two of the failures were caused by the executor argument
order and the test scope above.

## Migration steps

None required. Sandboxed commands whose scope lies under the temp directory now
see their writes succeed. Commands whose scope lies outside the temp directory
are unaffected.

## Known caveats

- AC-008 (sandbox overhead below 10%) is not changed by this fragment. It measured
  126–141% on the Ubuntu 26.04 runner once the Linux legs ran. Its threshold is a
  maintainer decision and is left unchanged here.
- AC-010 uses a single temp directory as its broad scope. It does not exercise a
  scope that spans several host directories.
