# Fix: Linux Bubblewrap sandbox emits a valid `--size` byte count

## What

The Linux Bubblewrap (`bwrap`) sandbox executor generated an invalid `--size`
argument for the `/tmp` tmpfs:

```
bwrap ... --size 500M --tmpfs /tmp ...
```

Bubblewrap's `--size` option accepts **only a plain non-zero decimal number of
bytes** and does not parse suffixes such as `M` or `MB`. As a result bwrap
rejected the value and aborted before the sandboxed process could start:

```
bwrap: --size takes a non-zero number of bytes
```

This broke every Linux sandboxed shell/bash command issued by swarm agents
(coders, reviewers, …) whenever the Bubblewrap sandbox was available.

The executor now emits the size as a decimal byte count — `524288000`
(500 MiB = 500 × 1024 × 1024) — via a named, documented module constant
`TMPFS_SIZE_BYTES` in `src/sandbox/linux/bubblewrap-executor.ts`. The two
unit-test assertions that previously locked in the buggy `500M` value now
assert the correct contract (`524288000`) and carry a `.not.toContain('500M')`
regression guard.

## Why

`bwrap` performs its own argv validation and exits non-zero on an unparseable
`--size` before exec'ing the wrapped command. The unit tests asserted on the
generated command string rather than against a real `bwrap` parse, so the
defective value was green by construction. This is a correctness fix to the
representation of an existing value (500 MiB tmpfs) — the intended tmpfs size
is unchanged.

## Migration

No breaking changes. No configuration, public API, or constructor-signature
change. The tmpfs size remains 500 MiB; only its serialization into the bwrap
argv changes from an invalid suffixed form to the required plain-byte form.

## Caveats

- Validated via unit tests (`tests/unit/sandbox/linux.test.ts`,
  `tests/unit/sandbox/linux-envoverride-verification.test.ts`) and a clean
  `bun run build`. A live `bwrap --size 524288000 --tmpfs /tmp …` end-to-end
  smoke test on a Linux host with bwrap installed is the gold-standard
  confirmation; the parse contract was confirmed against the bwrap manpage and
  upstream `bubblewrap.c` source.
