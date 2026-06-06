# PR #703 follow-up: council docs, config consistency, silent reduction warning

## What changed

Three medium-severity findings from the PR #703 review are addressed:

### 1. `docs/commands.md` — stale council interface removed

The `/swarm council` command signature and description have been updated to reflect
the post-#703 architecture:

- Removed the `--preset <name>` flag (preset-based member selection was removed in #703).
- Updated the description: the council is now a **fixed three-agent set**
  (`council_generalist`, `council_skeptic`, `council_domain_expert`); members no longer
  independently web-search; the architect owns the pre-search pass and supplies a
  RESEARCH CONTEXT block.
- Removed the reference to an "optional moderator pass" — the architect synthesizes
  the final answer directly.

### 2. Intentional `appendPrompt` omission documented

Council agents are created without the `appendPrompt` argument accepted by
`createReviewerAgent` / `createCriticAgent` / `createSMEAgent`. This is intentional:
council prompts are fixed and self-contained and must not inherit per-role workflow
customizations. An inline comment in `src/agents/index.ts` and two new notes in
`docs/configuration.md` make this explicit.

### 3. Deferred warning for silently reduced councils

When `council.general.enabled === true` but one or more of the `reviewer`, `critic`,
or `sme` base agents is disabled, the corresponding council role is now absent.
Previously this happened silently. A deferred warning is now emitted listing exactly
which council roles are missing and which base agents need to be re-enabled.

## Migration

No configuration changes required. Existing configs continue to work unchanged.

### 4. `dist/` build artifacts removed from PR branch

Committed `dist/` artifacts (`dist/cli/index.js`, `dist/index.js`, and 473 `.d.ts` type-declaration
files) have been removed from tracking in this PR. The `.gitignore` has been updated to use a
root-anchored `/dist/` rule (aligning with the enforcement introduced in PR #1132) so they cannot
be re-staged accidentally. CI builds and validates the dist from source; no manual rebuild step is
required.

### 5. Test coverage for reduced-council warning

A new describe block in `src/agents/council-registration.test.ts` covers the `councilAgentsCreated < 3`
warning path:

- Reviewer disabled → warning lists `council_generalist (requires reviewer)` with `2/3` count
- Critic disabled → warning lists `council_skeptic (requires critic)` with `2/3` count
- SME disabled → warning lists `council_domain_expert (requires sme)` with `2/3` count
- All three disabled → zero council agents registered; warning lists all three roles with `0/3` count
- Full council enabled → no council-reduction warning in `deferredWarnings`
- Named swarm with `reviewer` disabled → warning fires with correct prefix-aware detection (`isAgentDisabled` swarmPrefix path)

## Known caveats

None.
