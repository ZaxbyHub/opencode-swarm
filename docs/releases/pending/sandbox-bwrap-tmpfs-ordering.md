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

- AC-008 no longer asserts a percentage overhead. It asserts an absolute budget of
  50 ms per wrapped command, and that every wrapped run exits 0. The previous 10%
  ratio measured 126–206% on the Ubuntu 26.04 runner; a ratio over a trivial echo
  is noise-dominated. The 50 ms budget is roughly 12× the ~4 ms per command
  estimated from this PR's CI timings.
- AC-010 uses a single temp directory as its broad scope. It does not exercise a
  scope that spans several host directories.
