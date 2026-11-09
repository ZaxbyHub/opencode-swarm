---
issue: 3120, 3396
---

## Guardrails: verifier-config protection for every role, unconditional under `guardrails.enabled=false` (#3120)

`.secretscanignore` and every built-in verifier-config glob (`tsconfig*.json`,
`biome.json(c)`, `.eslintrc*`, `eslint.config.*`, `.prettierrc*`,
`prettier.config.*`, `oxlintrc*`, `.golangci*`) are now denied for **every
agent role** — including the OpenCode-native roles (`general`/`build`/`plan`/
`explore`) previously exempt from swarm write restrictions — and the denial
fires **even with `guardrails.enabled: false`** (and in observe contexts):
these files are owner policy for the verification system itself (the secretscan
Stage-A gate trusts `.secretscanignore`), so their integrity is not switchable
by the general enforcement knob. The shell path additionally routes no-scope
lenient roles through the verifier-config check (native-role `echo x >
.secretscanignore` via bash is blocked). Disclosed boundary: script runners
(`npm run <script>`, `bun run <script>`, `node <file>`) remain NOT treated as
shell write vectors — their targets are not statically knowable and blocking
them would break every legitimate build; see the `shell-write-detect` module
documentation.

## Shell write detection: patch, checkout-ref, rsync vectors (#3120)

`git apply` / `patch` (explicit `-p<n>`; both diff endpoints so a rename/delete
of a protected preimage cannot hide behind the postimage; closed option set —
`--directory`, `-d`, `-o`, `-r`, backup options, and index-writing modes
`--cached`/`--index`/`--3way` fail closed; `patch` without explicit `-p` fails
closed because GNU patch then picks basenames itself), `git checkout <ref>
<pathspec>…` (no `--`), and `rsync <src>… <dest>` are now detected as write
vectors and authorized per-target through the cd-tracking resolver. Targets
named inside a patch are extracted at authorization time from the patch file
(bounded read): tab- and space-prefixed `---/+++` headers, C-style octal
escapes (`\ooo` — accumulated as bytes and decoded once as UTF-8; unknown
escapes and undecodable sequences fail closed), all four quoted/unquoted
`diff --git` header combinations (git quotes each name independently
under its default `core.quotePath=true`), pure
rename sections (`rename from`/`rename to` — no `---/+++` lines), and
rename/delete endpoints that only exist as section headers. Patch targets
are judged under BOTH landings (git apply is patch-root-relative, GNU patch
is cwd-relative), and `rsync` also flags `--exclude`/`--include`/`--filter`
arguments as write paths. Unreadable/undecodable patches and stdin patches
block.

## PR_FEEDBACK: durably bound merge base + Stage A trust screens (#3396)

- PR_FEEDBACK activation resolves the merge base via ONE bounded `gh pr view`
  and durably binds `prFeedbackBaseRef/Sha` in gate state (fail-open: a
  resolution failure records `prFeedbackBaseBindingError` and never wedges
  activation; a failed binding is retried on the next matching re-activation
  and a successful re-resolution clears the stale advisory). The bound value
  is the real merge base (`git merge-base base_ref pr_head_sha`), not the
  base-branch tip, so callers whose base advanced keep trusted provenance.
  The `gh` subprocess runs BEFORE the checkout/session mutation locks so the
  network call never stalls concurrent gate mutations. Stage A verifies its
  caller-asserted `base_sha` against the binding: matching runs carry the
  root-level `prFeedbackStageABaseTrust: 'binding-verified'` verdict; a
  differing base ignores the caller provenance entirely (trusted
  base-identical scripts unavailable — identical to no-provenance) and
  persists a bounded `prFeedbackStageABaseMismatch` marker (durable-wins
  evidence, appended without advancing the gate revision, cleared by a head
  rebind). The receipt's strict child keeps the BASE two-value trust floor
  (rollback-safe: the 4-value verdict rides the passthrough-safe root field
  older binaries ignore). With no binding, the disclosed `caller-asserted`
  floor stays. The Stage A receipt now actually PERSISTS its base identity
  (the pre-fix call passed flat option keys the record schema ignored, so
  even the disclosure never landed).
- Directory-copy boundary (disclosed): `rsync <src>… <dest>` and `cp -r`
  write authorization judges the DESTINATION operand only — directory
  CONTENTS are not enumerated, so a source tree carrying a protected file
  copies without per-file authority. This is deliberate parity with the
  pre-existing `cp` treatment (content enrichment is a separate, larger
  change); direct writes to protected paths remain denied on every route.
- Base-identical **compound** scripts pass a closed plausibility screen before
  base-identity trust: the supported grammar is exclusively the non-empty
  all-`&&` chain, literal heads only, no substitution/redirection/control
  grammar/wrapper builtins/blocked executables/eval or workspace-override
  flags; the sole exemption is a terminal `echo`/`printf` progress tail with
  at least one real validation segment. `||`/`;`/pipe/newline compounds lose
  base-identity trust (`.pr-validation.json` remains the sanctioned contract
  path). The screen is a plausibility screen over base-identical text, not a
  sandbox (accepted risks disclosed: literal unblocked tools can still write;
  `NODE_OPTIONS`/variable-expanded arguments stay outside the literal screen).
- npm **lifecycle hooks** (`pre*`/`post*` around category stems, repeated
  prefixes for nested `prepretest` forms) are now base-checked: PR-added or
  modified `prebuild`/`postlint`/`pretest` hooks fail Stage A closed with a
  remedy; base-identical hooks are trusted (compound bodies screened) and
  attach to their primary script's obligation rather than creating
  unsatisfiable standalone obligations. Direct lifecycle-hook check commands
  (`npm run prebuild`) are rejected — the check must run the primary script.
  A PR-changed category-matched script whose simple parse is implausible now
  fails closed instead of being silently ignored (base-identical scripts keep
  the base's own choice).
