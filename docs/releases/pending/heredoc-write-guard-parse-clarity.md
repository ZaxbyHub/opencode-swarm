---
issue: 3754,3761
---

## Fixed: quoted-heredoc write-guard false positives, parse/policy message clarity, and root-escape layer naming

- **Quoted-heredoc cat writes no longer parse-block** (#3761): bash-parser
  0.5.0 has no here-document body lexing, so a `cat > file <<'EOF' … EOF`
  write whose body carried shell metacharacters (apostrophes, parentheses)
  was hard-blocked as a parse failure, and body text was misread as live
  commands. A new `neutralizeQuotedHeredocBodies` helper blanks the body of
  the one provably-safe shape — a single literal `cat` command with one
  whole-word-quoted heredoc (POSIX: no expansion in the body; `cat` never
  interprets stdin) — before parsing, threaded consistently through write
  detection, wrapper preprocessing, target resolution, the process-
  substitution scan, and `/swarm guardrail-explain`. The real redirect
  target keeps full scope checking.
- **Fail-closed surface unchanged for every other shape**: executing
  receivers (`bash <<EOF`, `cat <<EOF | bash`), glued assignments
  (`cat=foo bash <<EOF`), comment openers (`cat # <<'EOF'`), multiple
  heredocs, here-strings, partial-quoted or unquoted delimiters, unclosed
  heredocs, and CRLF terminators all keep today's fail-closed analysis.
- **Parse denials now say what they are** (#3761 expected behaviour,
  #3754 F2 UX half): genuine bash-parser failures read "parse failure, not
  a policy refusal" with a remedy hint, at all three gates and in every
  explain mirror; synthetic POLICY denials (ambient BASH_ENV/ENV/
  BASH_FUNC_* assignment, unsafe command text) get accurate policy
  messages, the oversized-word budget keeps its dedicated message, and the
  wrapper-preprocessing bound (empty/NUL chdir directory, ambiguous
  wrapper shape) reads "could not safely model this command" instead of
  masquerading as a parse error. One shared classifier
  (`classifyWriteParseFailure` / `describeWriteParseFailure`) drives the
  gates and `/swarm guardrail-explain`, so their wording cannot drift.
- **AUTHORITY_ROOT_ESCAPE names the deciding layer** (#3754 F3): the
  denial now carries `[layer=containment; rule=…]` and states that the
  host `permission.external_directory` setting does not bind the plugin
  authority layer.

### Known bounds (deliberate)

- Dense **unquoted** heredoc bodies still parse-block (expansion-capable
  class; tracked in #3616's parser-completion workstream, where the
  marker-scan fallback discussion also lives).
- Wrapped shapes (`bash -c "cat <<EOF …"`) are not neutralized (the
  wrapper path stays fail-closed).
- The destructive arm's shell-flag-cluster raw scan can still trip on
  heredoc body text documenting an interpreter invocation (pre-existing;
  same class as the absorbed #3616 items).
- `scope_validate` refuses every heredoc cat write with
  UNRESOLVED_TARGET (it does not skip the path-null here-doc marker the
  gate skips) — pre-existing, fail-closed direction, unchanged by this
  fix.
- Control characters (tab included) inside a NEUTRALIZED body are now admitted:
  the gate's control-character rule runs on the analysis string, where the
  inert body is blanked, so `cat > f <<-'EOF'` with a tab-indented body line
  is no longer refused (previously blocked). A tab-indented opener or
  terminator line, a tab-bearing command outside a neutralized body, and
  every non-neutralized shape remain refused (fail-closed). An out-of-scope
  redirect target is still denied `AUTHORITY_ROOT_ESCAPE`.
- The destructive arm still scans the RAW heredoc body for its own
  segmentation, so a body line such as `rm -rf ../x` inside a neutralized
  quoted heredoc is denied even though the body is inert data to `cat`
  (over-deny, fail-closed direction, pre-existing raw segmentation; only
  the process-substitution scan uses the neutralized string).
- A heredoc whose body carries a single whitespace-delimited word over the
  4096-character analysis budget is not neutralized and keeps the pre-existing
  oversized-word denial (the budget is checked on the original text).
- A large dense neutralized body costs a full parser walk of the blanked
  command (linear: about 206 ms at 42 KB and about 1.3 s at 429 KB, versus a
  fast parse-error exit before neutralization). No total-length bound is
  added, because one would re-deny the large inert bodies this fix admits.
- The read-only inline interpreter eval relaxation (#3754 Finding 1) is a
  recorded by-design decision (#3347); the discussion host is
  issue #3878.
