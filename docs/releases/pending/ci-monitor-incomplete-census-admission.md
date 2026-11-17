# CI Monitor admission with an incomplete census

Swarm CI Monitor uses the same required-check rule on gh and MCP hosts. It
keeps incomplete check-run observations visible and can proceed when authoritative
required-check evidence independently confirms the exact head is green. The
monitor refreshes that evidence for the current PR head and target base before
each merge attempt.
