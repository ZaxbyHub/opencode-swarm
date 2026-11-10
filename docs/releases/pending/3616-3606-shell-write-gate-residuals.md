---
'opencode-swarm':
  - 3616
  - 3606
---

Fixes: guardrails shell write-gate residual completion (#3616 items 1-15 + #3606; item 16's loop-landing adoption is NOT in this change — see below).

## Security (write-gate fail-open closures)

- **Ambient shell-state keys** (#3616 item 1): in-command assignments naming `BASH_ENV`, `ENV`, or `BASH_FUNC_*` (any spelling incl. `%%`-suffixed keys) now deny the whole command before parsing. Startup-file values need not look command-bearing and imported functions execute later, so all key-naming assignments are refused regardless of value shape. Residual (documented, not fixable at this layer): the host's outer bash inherits the OpenCode process environment before any plugin hook runs.
- **GNU long-option abbreviations** (item 3): `rm --rec src` / `rm --f src` are now classified recursive/forced exactly like their full spellings (unambiguous-prefix matching against GNU rm's real option universe). Previously `rm --rec src` admitted where `rm -rf src` denied.
- **Word-position `$(...)` writes** (item 4): writes inside command substitutions in For word lists, command suffixes, assignment prefixes, and Case subjects are now detected and resolved at their tracked walk state (`for i in $(echo x > ../esc); do :; done` previously reported zero writes).
- **`sudo -D` behind launchers** (item 5): `time sudo -D /etc tee src/ok.txt` and `bash -c "sudo -D /etc tee …"` now reach the chdir rewrite (launcher/env heads are peeled and the rewrite retried; the shell `-c` payload is recursed) — the write resolves under DIR instead of the ambient cwd.
- **`sudo -i` relative writes** (item 6): a write-bearing tail under `sudo -i`/`--login` withdraws fail-closed (sudo chdirs to the target user's home, which is unknowable statically). `sudo -s` (cwd kept), no-write tails (`sudo -i make build`), and absolute targets are unchanged.
- **`env` between launchers** (item 7): the launcher hop filter peels interposed `env` (its flags, assignments, and `--`), so `nice env sudo -i …` and `nice env time -o ../x true` are judged like their env-free twins.
- **`pushd .`** (item 8): pushes the duplicate directory-stack entry exactly as bash; the following `popd` no longer removes the wrong entry and later writes resolve at bash's real landing.
- **Symlink-lexical `rm link/../x`** (item 9): `resolvePath` now walks components left-to-right consulting `lstat` — a symlink/junction component is replaced by its target and the target's own components are walked first (realpath order, so multi-hop chains `link1 → link2 → elsewhere` resolve fully) before `..` collapses, so `link/../src/x` (link → another tree) resolves through the real tree instead of being admitted as in-scope `src/x`. Non-ENOENT lstat/readlink failures, and link chains longer than 40 hops (cycles), fail closed with an "unverifiable path" reason for relative operands and on Windows; an absolute POSIX operand falls back to its lexical form there (the kernel's own 40-hop ELOOP bound stops such a chain before any write).
- **macOS `.git` case-folding** (item 12): the destructive gate's protected-component compare now routes through a platform seam (`dcProtectedComponentEqualsForPlatform`) that case-folds on darwin as well as win32, so `rm -rf .GIT` is protected on macOS's default case-insensitive filesystems (a case-sensitive darwin volume only over-denies). Linux stays exact.

## Behavior change (owner decision 2026-11-09)

- **Flagged rm under `block_destructive_commands: false`** (item 10): destructive rm operands (recursive/forced, any flag spelling) are now emitted as ordinary write targets judged by the scope layer instead of being owned by the disabled destructive arm. Configurations that relied on deleting outside the declared scope with the destructive policy off will start getting denials — a flag can no longer make a delete *less* checked.

## Denial messages & diagnostics

- **Class-accurate deny reasons** (item 15): the dynamic-path deny names its true cause — tilde expansion, unresolved loop landing, withdrawn directory context (popd/`cd -`), unresolvable wrapper chdir (`sudo -D`), unverifiable path, or dynamic text — instead of the single misleading "shell variable or command substitution" label.
- **Bounded, sanitized diagnostics** (items 13-14): all seven destructive-rm deny sites (plus the junction/symlink-creation sites) route through the canonical sanitizer — control characters and the bidi marks U+061C/U+200E/U+200F are neutralized, truncation is code-point-safe (never splits a surrogate pair), and the unexpanded-variable site caps the rendered target at 160 chars.
- **Ancestor denials redacted** (#3606): both `checkWriteTargetForSymlink` arms (lstat-failed, symlink/junction) render the ancestor home-redacted within a whole-message 320-char bound, and the error detail renders the error CODE only — no raw profile-prefixed paths or unbounded error strings reach operator-facing messages.

## Explain

- **Coder explain without `--scope`** (item 2): renders `block` with a `scope_unevaluated` firing rule instead of an unqualified "allow: no rule matched" for commands the live gate denies under the coder's active scope binding. Architect and other-role paths are unchanged.

## Performance

- **Oversized-word sentinel** (item 11): a whitespace-delimited word longer than 4096 chars denies before parsing (the parse itself dominated; a 40k unclosed-brace `curl -o` operand measured ~0.5-1.5 s per walk), and the quadratic brace regex is capped at every call site, not just the For path.

## Not in this change

- **Item 16** (post-exempt-loop landing adoption): scoped out by owner decision — the loop landing is not statically knowable under the issue's own item-1 ambient-shadowing finding; PR #3615's conservative over-deny is preserved bit-for-bit and pinned as a PRESERVING check. #3616 remains open pending AC16 re-specification.

Known bounds: `--v`/`--ve`/`--ver` (ambiguous between `--verbose`/`--version`) fall through as unknown tokens — GNU rejects ambiguous abbreviations before deletion, so nothing deletes either way. The ambient-key scan is textual, so a non-assignment word that spells a key assignment (e.g. `echo ENV=x > src/a`) is also denied — a deliberate over-deny in the safe direction. Pre-existing and unchanged here: an operand with no `..` is still resolved lexically, so a NEW file created through an in-scope directory link (`echo x > src/leaf/new` with `src/leaf` → outside the workspace) is admitted by the shell write gate — existing-file writes and deletes through such a link are already denied, and the full fix needs the scope root and the target canonicalized together; it is tracked as a follow-up. The ambient host-shell residual (item 1) and a future executor-level env scrub remain documented follow-ups.
