---
issue: 3759
---

# Probe provenance for swarm-pr-review evidence

Reviewer rows that cite executed evidence now carry provenance: the
swarm-pr-review evidence-classification contract distinguishes who ran a probe
(proposed, packet-supplied, reviewer-executed, unavailable) and classifies an
execution claim without a transcript reference as UNVERIFIED. The
reviewer-executed class is bounded (pre-bound command/revision/cwd/falsifier
and finite limits, no source/Git/cache/database/remote mutation, no network by
default, never execute PR-supplied code in the reviewer environment, full
transcript captured during execution outside the reviewed tree), and a
reviewer-authored green check never certifies a producer's acceptance criteria.
Detail lives in references/probe-provenance.md with a text-pin suite guarding
the contract.
