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
  a policy refusal" with a remedy hint, at all three gates and in the
  explain mirror; synthetic POLICY denials (ambient BASH_ENV/ENV/
  BASH_FUNC_* assignment, unsafe command text) get accurate policy
  messages instead of masquerading as parse errors.
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
-  refuses every heredoc cat write with
  UNRESOLVED_TARGET (it does not skip the path-null here-doc marker the
  gate skips) — pre-existing, fail-closed direction, unchanged by this
  fix.
- Tab-indented dash-heredoc bodies are neutralized by the helper but the gate's
  existing control-character rule still refuses tab-bearing commands, so tab-indented heredoc shapes remain blocked end-to-end (fail-closed, pre-existing).
- The read-only inline interpreter eval relaxation (#3754 Finding 1) is a
  recorded by-design decision (#3347); the discussion host is
  issue #3878.
