# Receipt surfaces: documented the intentional toolPolicy/agents asymmetry

## What

Comment-only change (no behavior): the `receipt` command keeps
`toolPolicy: 'agent'` in `src/commands/registry.ts` while the `receipt` tool
names only architect/reviewer/critic_finding_validator in
`src/tools/tool-metadata.ts`. Both definition sites now carry paired
comments recording that the asymmetry is a deliberate, critic-reviewed
disposition from PR #3550: receipt truth derives entirely from durable
state, so broader call-path reachability cannot mint unearned gate passes,
and an emitter-identity field would be equally forgeable. The comments
direct any future "alignment" through the undecided questions first
(emitter authority, out-of-band report anchor — trigger: the first consumer
that gates on receipt authenticity), preventing a reflexive fix.

## Why

Found by the post-merge independent critic pass over the PR #3550
disposition ledger (user-directed routing of ASK items). Recorded here as
the approved follow-through of that adjudication.
