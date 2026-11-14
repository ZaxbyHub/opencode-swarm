# Swarm-PR-Feedback gate amendments: recorded re-fetch (all profiles), named probes and restart inventory (Profiles B/C)

## What

Three amendments to `.opencode/skills/swarm-pr-feedback/SKILL.md`, each carried by field evidence from the ragappv3 PR #1120 retrospective (dual-critic consolidated, 2026-11-14). The first applies under EVERY profile (the controller records no comment fetch mechanically, so Profile A needs the receipt most — review pr3698-20261114 CT-1 residual); the other two are Profiles B/C:

- **Round-boundary re-fetch is a recorded obligation.** A critic NEEDS_REVISION that restarts the gate ladder counts as a fix round (re-fetch due before gates re-run), and every boundary fetch appends a receipt to the findings ledger (surfaces fetched, comment ids seen, timestamp) so an unreconciled out-of-band review is visible in the artifact instead of silently missing. Field evidence: a five-MEDIUM out-of-band bot review posted between two orchestrator comments on ragappv3 PR #1120 stayed un-ingested until the closeout critic's mandated fetch caught it.
- **Stage B test-engineer verdicts must name the discriminating probe** (runtime mutant, source surgery, or executed pre-fix failure, with the observed failure mode). A PASS whose only evidence is a green suite is test theater — a hollow static pin survived a full review ladder on the same PR until the reviewer simulated the mutation.
- **New "Pre-flight: Restart Inventory (Profiles B/C)" section.** After a harness session restart, record a four-bucket inventory (reusable artifacts / stale approvals / dead agent ids / fresh-dispatch work) in the task-gates artifact before dispatching; dead agent ids do not resolve, and in-flight lanes need fresh dispatch with complete standalone context packets. Field evidence: two session restarts in one retro session orphaned 46 child sessions.

## Why

All three gaps produced real rework in one session: the un-ingested bot review cost a full re-gate round; the hollow pin shipped in a reviewed head and needed a second round to expose; the restart orphans were recovered ad hoc with no recorded inventory.
