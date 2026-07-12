# Audit fixes — 1 CRITICAL + 6 HIGH defects (issue #1778)

## What changed

Fixes the consolidated audit tracker (#1778): safety mechanisms that passed their
tests and reported healthy but did not actually protect production data. Each is
now fixed with regression coverage.

### Security

- **`extract_code_blocks` can no longer write outside the workspace (CRITICAL).**
  The tool now resolves and contains every write target against the workspace
  root, rejects absolute/traversal `output_dir`, requires bare filenames (a
  crafted `# filename: ../../evil` comment is rejected), and refuses to write
  through a symlink (including a broken one). It is now classified as a write
  tool and removed from read-only agent roles (explorer, sme, reviewer) and from
  the delegating architect — read-only and orchestrator roles no longer hold a
  file-writing tool.

- **Shell guards are no longer trivially bypassable.** `rm` recursive/force
  detection now catches stacked flags like `rm -rfv` / `rm -vrf`; a destructive
  command hidden after a lone `&` separator is now split and inspected (POSIX
  `2>&1` / `>&` / `&>` fd-redirects are preserved, not mis-split); write
  detection now unwraps `bash -c '…'` / `sh -c '…'` / `eval '…'` so a redirect
  hidden inside a one-layer wrapper is no longer invisible; and no-scope agents
  now have the universal-deny prefixes enforced on shell writes instead of being
  skipped entirely.

- **Bun-runtime subprocess timeouts are now enforced.** A subprocess that traps
  SIGTERM could previously evade a spawn timeout indefinitely on the Bun path;
  timeouts now escalate to SIGKILL, matching the Node path.

### Reliability

- **Local-model system-message consolidation now runs on real data.** The
  `messages.transform` consolidation (collapse to a single system message at
  index 0; strip stray system messages at index > 0, which local models such as
  Qwen/Gemma crash on) now handles the actual `{info, parts}` message shape, not
  just the flat test shape — previously it was a silent no-op in production.

- **One config typo no longer wipes your entire configuration.** A single
  unrecognized key in a strict section (`council`, `checkpoint`, `pr_monitor`,
  `turbo.epic`, …) now drops only that key with a named warning and preserves the
  rest of your config, instead of falling back to guardrails-only defaults.
  `/swarm doctor` also surfaces such unknown keys. (Generalizes the #1690/#1732
  gates-only fix to every strict section; fail-secure behavior on a genuine
  load failure is preserved.)

- **The preflight governance queue no longer bricks after 100 triggers.** A
  long-lived process crossing 100 phase boundaries no longer permanently and
  silently stops running preflight; the accounting queue is now a bounded
  rolling window (opt-in evict-oldest) that never gates the run, and dropped
  preflights are surfaced as an operator warning.

### Sandbox honesty

- **`/swarm doctor` no longer reports advisory sandboxing as strong.** On the
  Windows PowerShell fallback (environment scrub, not kernel enforcement) the
  doctor now reports `⚠️ advisory (NOT kernel-enforced)` instead of a green
  check. The macOS Seatbelt profile ordering was corrected so in-scope writes are
  allowed while out-of-scope writes stay denied. (The signed per-platform native
  runner binaries still require a build+signing pipeline on the respective OS;
  until then the runtime uses the advisory fallback and now says so honestly.)

### CI coverage

- **CI now runs the previously-orphaned test trees.** `src/**/*.test.ts` and
  `tests/adversarial/` (284 files, including the adversarial security suites)
  were never executed by CI; they are now wired into the unit job and coverage
  gate (shards rebudgeted 4→6, coverage floor recalibrated for the larger set).
  Wiring them surfaced — and this change fixes — several genuinely-failing tests
  that green CI had been hiding.
