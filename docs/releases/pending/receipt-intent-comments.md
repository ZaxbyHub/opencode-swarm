# Receipt surfaces: documented the intentional toolPolicy/agents asymmetry

## What

Comment-only change (no behavior): the `receipt` command keeps
`toolPolicy: 'agent'` in `src/commands/registry.ts` while the `receipt` tool
names only architect/reviewer/critic_finding_validator in
`src/tools/tool-metadata.ts`. Both definition sites now carry paired
comments recording that the asymmetry is a deliberate, critic-reviewed
disposition from PR #3550: receipt content derives solely from durable
state plus emitter constants — the caller cannot influence what a receipt
attests — so broader call-path reachability cannot forge content, and an
emitter-identity field would be equally forgeable without an attestation
key. The comments direct any future alignment through the undecided
questions first (emitter authority, out-of-band report anchor — trigger:
the first consumer that gates on receipt authenticity) and cite the
separately tracked task-arm outcome-fidelity gap (issue #3560),
preventing a reflexive fix.

## Why

Found by the post-merge independent critic pass over the PR #3550
disposition ledger (user-directed routing of ASK items); the wording was
then corrected to content-provenance claims during the swarm-pr-review
round on this PR after an executed probe showed the task-arm outcome values
are emitter constants, not verdict-faithful attestations (tracked at #3560).
