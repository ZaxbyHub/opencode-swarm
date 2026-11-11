# Ancestor write-denial messages no longer disclose raw profile paths

## What changed

- Both ancestor denial arms in `checkWriteTargetForSymlink`
  (`src/hooks/guardrails/file-authority.ts`) — the lstat-failure arm and the
  symlink/junction arm — now render the resolved ancestor path through the
  same bounded-and-redacted contract that issue #3587 established for the
  four main denial doors: home/profile prefix folded via `redactPath`
  (`src/scope/path-identity.ts`), control and bidi characters neutralized,
  and length capped at 320 chars via `sanitizeDiagnosticText`. For absolute
  paths this is byte-identical to `renderDenialTarget`
  (`src/hooks/guardrails/tool-before.ts`); it is inlined in file-authority
  because importing the helper back from tool-before would create an import
  cycle.
- The lstat arm's error detail previously interpolated `String(err)` raw and
  unbounded. A system error string embeds the lstat operand verbatim
  (e.g. `statx '<path>'`), so on a workspace under the user profile the
  message leaked the profile prefix twice. The fix folds every occurrence of
  the raw ancestor inside the error text into its already-redacted render
  before sanitizing and capping the detail at 160 chars.
- The denial DECISION logic is untouched: ENOENT still walks through,
  any other lstat error still fails closed, and a symlink/junction ancestor
  still refuses the write.
- New `_internals` seam in file-authority (`lstatSync`) so suites can inject
  lstat outcomes for workspaces that do not exist on the host, and a new
  regression suite
  `tests/unit/hooks/guardrails-ancestor-denial-redaction-3606.test.ts`. Its
  unit legs use a fabricated `/home/<name>` workspace and run on every host.
  Its end-to-end write-tool leg uses a real symlink directory and reports an
  explicit skip on hosts that cannot create symlinks.

## Why

Issue #3606 (follow-up from PR #3592): the two ancestor arms of
`checkWriteTargetForSymlink` interpolated the workspace-resolved ancestor path
raw into operator-facing `WRITE BLOCKED` messages. When the workspace sits
under the user profile, that disclosed the runtime profile prefix verbatim —
the same disclosure class #3587 closed for the four main denial doors — and
the lstat arm additionally embedded an unbounded system-error string.

## Migration steps

None required. Denials fire identically; only the message text changes.
Tooling that matches the literal message shapes (`WRITE BLOCKED: lstat
failed on …`, `… is a symlink/junction …`) keeps matching; anything that
parses the quoted path slot must now expect a `~`-folded, ≤320-char render.
`ShellWriteBlockedError.writeTarget` keeps the exact value in memory. The
audit row's `path` and `reason` fields are written through the audit writer's
own redaction, as before.

## Known caveats

- The audit row's `reason` field carries the same bounded reason string. The
  audit writer already redacts `path` and `reason` on serialization
  (`src/hooks/guardrails/audit-log.ts`), so this change's on-disk delta for the
  audit row is the 320/160-char bounds and the ancestor fold in the reason text.
- The same `checkWriteTargetForSymlink` text also reaches `declare_scope`
  `errors[]`, the `prepare_pr_feedback_scope` failure message, and
  `scope-validate` (boolean result only). On those surfaces the quoted path is
  now a `~`-folded render, not a copyable absolute path.
- The sibling ancestor walk guarding recursive deletes
  (`dcLstatAncestorWalk` in `src/hooks/guardrails/destructive-command.ts`)
  still renders raw ancestors; that surface belongs to the #3616 residual
  cluster and is intentionally out of scope here.
- The new tests live in a dedicated file rather than the #3587 suite because
  that suite sits at 480 lines and the FR-006 cap ratchet fails any modified
  test file that grows past 500.
- The planted-link denial in the linked-worktree containment path
  (`findPlantedLinkBelow` in `src/hooks/guardrails/file-authority.ts`) renders
  its quoted symlink path through the same redacted, 320-char-bounded contract.
  This is a source-verified change; no test pins its rendering on this release.
- Pre-existing residual, not changed here: `redactPath` does not fold the
  extended-length `\\?\` prefix, WSL `/mnt/c/Users/<name>`, `/var/home/<name>`,
  or `/export/home/<name>`. A username in those shapes can still appear in
  `WRITE BLOCKED` text. Recorded in the PR's considered-not-filed table.
