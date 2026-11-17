---
issue: 3306
---

# Fragment-gate hardening: byte-strict decoding, aggregator parity, argv strictness, test hygiene

## What

- `scripts/check-pending-fragment.ts` now decodes list inputs byte-strictly:
  invalid UTF-8 (file or stdin) and NUL bytes inside newline-framed input
  exit 2 with no verdict instead of silently classifying replacement
  characters or a glued blob as one path (#3306 AC1/AC2).
- `isPendingFragment` (`scripts/user-visible-paths.ts`) matches the release
  aggregator's name rules: C0 control characters, `..` segments,
  leading-`./` forms, and any backslash-bearing name (the aggregator's
  collection path cannot resolve the normalized form, so a root-level
  backslash-named file would pass the gate yet ship no release note) no
  longer satisfy the fragment mandate, and
  the `.md` suffix matches case-insensitively, so a `X.MD` fragment that the
  release pipeline would collect is no longer rejected by the gate (#3306
  AC3/AC4). The pull_request display in `pr-standards.yml` matches `.MD`
  fragments too, and its `localWorkflowHashes` pin is refreshed in the same
  change.
- A stat-able but unreadable list file now exits 2 through the usage-error
  path instead of an uncaught stack trace (#3306 AC5; new
  `_internals.readFileSync` seam + exported `readBoundedFileSync`).
- A `--`-prefixed token after a value-taking option is a usage error, and
  direct `--added` values are decoded under the selected framing with
  exactly-one-path cardinality (empty, multi-record, and separator-bearing
  values exit 2) (#3306 AC6/AC7).
- Matched fragment names and visible paths are rendered with every control
  byte (C0 and DEL) in explicit `\xNN` form in gate messages (#3361 AC4
  escaping arm).
- Test hygiene: the transport suite removes every temp directory it creates
  (exact-list `afterAll`), and every test that parsed YAML through the
  transitively-resolved `yaml` package now imports the declared `js-yaml`
  instead (#3308 AC4/AC5; the release-owner guard forbids non-release PRs
  from editing package.json, so declaring `yaml` itself is not possible
  here). New pre-authored battery
  `tests/unit/scripts/check-pending-fragment-strictness-3306-3308-3361.test.ts`
  pins the one-listing invariant, the jsonl lone-record fixture, the
  `--paths-format` enum branch, the argv→source matrix, the pull_request
  arm's empty-changed exit, and the uppercase-`.MD` display.

## Why

The gate and the release aggregator disagreed about which names count as
pending fragments, malformed lists could produce a verdict instead of exit
2, and several load-bearing behaviors (one gh listing per dispatch,
jsonl-newline handling, the enum branch, the empty-changed exit) shipped
with no discriminating test — a regression in any of them would have stayed
green.

## Verification

17 frozen acceptance checks (9 DISCRIMINATING RED→GREEN, 6 PRESERVING
GREEN→GREEN, battery-integrity NEW-SURFACE + its C5 seam row): all PASS at the
shipped head (battery: 27 pass + 1 by-design POSIX-only skip);
15-suite fragment-gate battery 256 tests, 255 pass + 1 by-design POSIX-only
skip, 0 fail; typecheck, biome ci, check:test-tmpdir, check:test-clock,
check:mock-cleanup, required-check-contract green.

## Migration

No workflow changes needed for well-formed inputs; every strictness change
fires on inputs that are malformed (invalid UTF-8, NUL-in-newline, flag-like
values, multi-record argv values) or on names the release pipeline cannot
actually collect (backslash/dotdot/dot-slash-prefixed fragment names). Two
classes deserve explicit mention: a repository path that is not valid UTF-8
(legal on POSIX filesystems) now fails the gate closed through the
infrastructure envelope instead of classifying with substituted characters,
and a direct `--added` value under the legacy newline framing tolerates
leading/trailing line separators (embedded separators are refused).
Deliberate verdict changes: X.MD fragments now satisfy the gate
and are displayed (matching the release aggregator), and a BOM-prefixed path name keeps its U+FEFF (the
decoder preserves the byte order mark) so a BOM-prefixed pseudo-fragment
cannot satisfy the mandate - the aggregator's collection requires the
literal docs/ prefix.
