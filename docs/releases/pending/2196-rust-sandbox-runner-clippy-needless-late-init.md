# swarm-sandbox-runner: clippy needless_late_init fix (unblock merge queue)

## What changed

- Rewrote two `let exit_code;` late-initialization sites into direct
  `let exit_code = if … else …;` expressions in
  `runners/swarm-sandbox-runner/src/mode/restricted_token.rs` and
  `runners/swarm-sandbox-runner/src/mode/app_container.rs`. The branches that
  terminate the run still `return Err(...)` (the never type coerces into the
  `if` expression's type), and the fall-through branch still evaluates to
  `code as i32` — behavior is unchanged, only the shape of the binding.

## Why

The `rust-sandbox-runner` CI job (merge-queue only, Windows) runs
`cargo clippy --all-targets -- -D warnings` on `channel = "stable"`, which
drifted to Rust 1.98.0. The newer clippy flags the pre-existing
`clippy::needless_late_init` pattern in both Windows sandbox modes, failing
every merge-group build with 2 errors — even for PRs that do not touch the
runner. This blocked the entire merge queue. Applying clippy's own suggested
rewrite resolves the lint at the source and unblocks queue merges.

## Migration steps

None. No behavior, CLI, or config surface changed; this is a lint-only
refactor of two functions.

## Known caveats

- `runners/swarm-sandbox-runner/rust-toolchain.toml` pins
  `channel = "stable"`, so future toolchain releases may introduce new
  deny-by-default lints the same way. Pinning an exact version is a possible
  follow-up but changes upgrade policy and is out of scope here.
