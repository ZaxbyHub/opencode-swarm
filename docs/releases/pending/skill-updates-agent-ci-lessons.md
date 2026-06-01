# Agent skill updates: CI lessons from Windows sandbox runner PR

## What changed

- **`commit-pr` skill** — new "GitHub auto-merge race condition" section under Step 7 Conflict closeout, and a new Step 9 pre-merge checklist item requiring independent adversarial review for high-risk work
- **`qa-sweep` skill** — new timing requirement on Phase 2: adversarial review must complete before the final substantive push, not after CI
- **`rust-crate-ci` skill** — new skill covering the mandatory local validation gate (`cargo fmt --check` → `cargo clippy` → `cargo test` → `cargo build --release`), common rustfmt line-length quirks, Windows-specific Rust correctness patterns (`\\?\` verbatim prefix, 8.3 short names in `%TEMP%`, `HANDLE` Send+Sync), and the IPC exit-code/event contract for `swarm-sandbox-runner`

## Why

These changes were extracted from the PR #1068 session (Windows native sandbox runner). Three recurring failure modes surfaced:

1. **Adversarial review ran too late** — it was deferred until the stop hook forced it, at which point it found three blocking bugs in already-pushed commits (exit code clamping, missing exit events on kill paths, `writable_roots` excluded from symlink egress check). The qa-sweep timing requirement and commit-pr checklist item close this gap.

2. **GitHub auto-merge race** — when `main` advanced while PR #1068 was open, GitHub automatically pushed a merge commit to the branch without rebuilding `dist/`, causing `dist-check` to fail. The new section in `commit-pr` documents the symptom, explains why it happens, and gives the exact recovery sequence.

3. **Rust CI iteration cost** — the `enforce_symlink_egress` function required four separate fix commits (verbatim prefix, rustfmt format!, 8.3 short names, rustfmt events::emit) that each could have been caught with the right local gate. The `rust-crate-ci` skill documents the pitfalls so future Rust crate work avoids the same cycle.

## Migration steps

None. Skills are advisory. Existing workflows are unchanged.

## Breaking changes

None.

## Known caveats

The `rust-crate-ci` skill is specific to `runners/swarm-sandbox-runner/`. If the repo gains additional Rust crates, the skill's CI workflow reference section should be updated.
