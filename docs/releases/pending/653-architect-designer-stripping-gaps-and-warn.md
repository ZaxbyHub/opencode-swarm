# fix(agents): fill designer-stripping gaps and warn on unstrippable custom-prompt references (#653)

## What changed

Three designer references in `ARCHITECT_PROMPT` were never stripped when `ui_review` is disabled:

1. **Knowledge directive** (line 460): `"3. Delegating to coder, reviewer, test_engineer, sme, docs, or designer."` — the trailing `, or designer` was not removed.
2. **Delegation example** (lines 615–621): The existing regex used `accessibility(?=\n\n## WORKFLOW)` as the stop anchor, but the actual block ends with a `SKILLS: none` line before `## WORKFLOW`, so the lookahead never matched and the block remained in the stripped prompt.
3. **SKILL AGENT TARGET RENDERING** (line 654): `"- the active swarm's designer agent = @{{AGENT_PREFIX}}designer"` was listed alongside other agents but never removed.

Three dead stripping calls that targeted strings not present in `ARCHITECT_PROMPT` were also removed (the `5a. **UI DESIGN GATE**` pipeline step, the `→ After step 5a (...)` transition instruction, and the scaffold-INPUT coder reference). These were no-ops.

After the corrected stripping block, a `console.warn` fires if any `designer` reference survives. This surfaces the case where a user has supplied a custom `architect.md` prompt whose wording does not match the target strings — which would otherwise produce a silent runtime "designer is not a valid agent" dispatch error.

## Why

The stripping introduced in #651 was incomplete: the architect's system prompt still advertised the designer agent in three locations even when `ui_review` is disabled. Any Task delegation to `@designer` in that state would be rejected at runtime with no useful error. The warning added here closes issue #653 by making the silent failure visible at plugin initialization time.

## Migration steps

No migration required. The change is backward-compatible: the `console.warn` fires only when `ui_review` is disabled (the default) and the post-strip prompt still contains `designer` — meaning a custom `architect.md` prompt has designer references that could not be automatically removed. Users who see this warning should review their custom prompt and remove or conditionally gate any `@designer` references.

## Breaking changes

None.

## Known caveats

The `designer` substring check may produce false positives for custom prompts that mention "designer" in a non-agent-dispatch context (e.g., `"the human is a UX designer"`). This is an acceptable trade-off: false positives are a warn-only signal, and the alternative (missing the actual failure) is worse.
