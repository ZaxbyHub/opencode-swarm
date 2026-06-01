---
name: rust-crate-ci
description: >
  Load before editing any Rust crate in this repo (currently runners/swarm-sandbox-runner).
  Covers the mandatory local validation gate, common rustfmt/clippy pitfalls, and
  Windows-specific Rust correctness patterns that CI enforces but are hard to catch locally
  without a Windows toolchain.
effort: low
---

# Rust Crate CI Guide

This repo contains a Rust crate at `runners/swarm-sandbox-runner/`. The CI job that
validates it is `rust-sandbox-runner` (runs on `windows-latest`). This guide prevents
the most common failure modes before they reach CI.

## Mandatory local gate (run in order before pushing)

```powershell
cd runners/swarm-sandbox-runner

# 1. Format check — CI fails here first; clippy will not run if this fails
cargo fmt --check

# 2. Clippy — -D warnings makes all warnings hard errors, matching CI
cargo clippy -- -D warnings

# 3. Tests — run on the current platform; Windows-specific tests are gated with #[cfg(windows)]
cargo test

# 4. Release build — confirms the binary compiles with optimizations
cargo build --release
```

Run them in this exact order. If `cargo fmt --check` fails, fix formatting first —
clippy errors may be masked until fmt passes.

If `cargo` is not in PATH locally (e.g. you are on a machine without Rust installed),
push to a draft PR and let CI run the checks. Read the CI log carefully; do not guess
at what failed.

## How rustfmt makes decisions

rustfmt 1.95.0 applies line-length thresholds per syntax item, not per file or per block.
Two patterns that look equivalent locally can format differently:

**Long `format!` macros:** If the total length of `format!("...", arg)` exceeds the
line limit, rustfmt splits it. If it fits on one line, rustfmt collapses it.

```rust
// rustfmt will COLLAPSE this to one line if it fits:
return Err(RunnerError::PolicyViolation {
    reason: format!(
        "cwd resolves outside allowed roots (symlink egress): {canonical_str}"
    ),
});

// rustfmt will SPLIT this if it exceeds the limit:
events::emit(&events::denial_event("deny_symlink_egress", Some(canonical_str)));
// becomes:
events::emit(&events::denial_event(
    "deny_symlink_egress",
    Some(canonical_str),
));
```

**Rule of thumb:** After editing, always run `cargo fmt` (not `--check`) locally to
apply rustfmt's opinion, then read the diff before committing. Do not hand-format
and assume rustfmt agrees.

## Common clippy errors in this codebase

**`windows-rs` 0.58 API changes:** Several Win32 APIs changed signatures between
`windows` crate versions. The `Cargo.toml` pins the version; do not bump it without
checking the full API diff.

**`HANDLE` is not `Send + Sync`:** Raw `HANDLE` values cannot be sent across threads.
Wrap them in a newtype with `unsafe impl Send` and `unsafe impl Sync`, or use
`OwnedHandle` from `std::os::windows::io`. The kill-callback pattern in
`temp_watcher.rs` uses raw `isize` (handle as integer) to sidestep this.

**Unused imports:** `#[cfg(windows)]` blocks frequently hide imports that are used
only on Windows. On non-Windows builds, the import becomes dead code. Use
`#[cfg(windows)]` on the `use` statement itself or accept the `#[allow(unused_imports)]`
annotation for platform-conditional code.

**`struct` default initialization:** For Win32 structs like `STARTUPINFOW`, use a
struct initializer with `..Default::default()` rather than `unsafe { std::mem::zeroed() }`
— clippy flags the latter when `Default` is available.

## Windows path normalization (critical correctness patterns)

These bugs are invisible on Linux/macOS CI and will only appear on `windows-latest`.

### `std::fs::canonicalize` always prepends `\\?\`

On Windows, `canonicalize` typically returns a verbatim extended-length path with
the `\\?\` prefix, but this is not guaranteed across all Windows configurations and
path forms. Always use `.strip_prefix` with a fallback:

```
C:\foo\bar  →  \\?\C:\foo\bar  (typical)
```

If you compare a canonicalized path against a policy root stored without this prefix,
the comparison silently fails. Strip the prefix before comparing, always with `.unwrap_or`:

```rust
let lower = canonical.to_string_lossy().to_lowercase();
let canonical_str = lower.strip_prefix("\\\\?\\").unwrap_or(&lower);
```

Apply the same strip to both sides of any comparison.

### GitHub Actions CI uses 8.3 short names in `%TEMP%`

`std::env::temp_dir()` on GitHub Actions Windows runners returns a path like:
```
C:\Users\RUNNER~1\AppData\Local\Temp
```

But `std::fs::canonicalize` expands it to:
```
C:\Users\runneradmin\AppData\Local\Temp
```

If your code stores the `temp_dir()` path as a policy root and then canonicalizes
the cwd, the comparison will fail because `RUNNER~1` ≠ `runneradmin`.

**Fix:** Canonicalize both the policy root AND the cwd before comparing. Fall back
to the raw value if the root does not exist on disk yet:

```rust
let root_resolved = std::fs::canonicalize(root)
    .map(|p| p.to_string_lossy().to_lowercase())
    .unwrap_or_else(|_| root.to_lowercase());
let root_cmp = root_resolved
    .strip_prefix("\\\\?\\")
    .unwrap_or(&root_resolved)
    .to_owned();
```

### `WaitForSingleObject` return value semantics

`WAIT_TIMEOUT` is `0x00000102u32`, not a Rust `Err`. Check the return value
explicitly before treating the child as having exited normally.

## IPC contract stability

The exit codes in `error.rs` are **frozen** — do not renumber them. TypeScript
callers in `runner-client.ts` depend on these values:

| Code | Meaning |
|------|---------|
| 0 | Child exited zero (or non-zero child exit code passed through directly) |
| 64 | Policy violation |
| 65 | Temp quota exceeded |
| 66 | Wall-clock timeout |
| 67 | Launcher misconfiguration or policy parse error (invalid JSON from caller) |
| 68 | OS API failure, I/O error, or JSON error |
| 69 | Probe failed |

The NDJSON event types on stderr (`start`, `denial`, `quota_exceeded`, `exit`) are
also frozen. Adding new event types is safe; renaming or removing existing ones
is a breaking IPC change.

**Exit events are required on every termination path.** Emit `exit_event` before
returning from both the wall-clock timeout path and the temp-cap kill path, not
only on the normal exit path. TypeScript consumers block waiting for an `exit` event.

## CI workflow reference

The job is defined in `.github/workflows/ci.yml` as `rust-sandbox-runner`.
It runs on `windows-latest` with the toolchain pinned in `runners/swarm-sandbox-runner/rust-toolchain.toml`.
All third-party `uses:` actions are pinned to 40-character SHAs per the repo policy.

Steps in order: fmt check → clippy → tests → release build → probe smoke test.
