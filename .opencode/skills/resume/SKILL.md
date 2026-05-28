---
name: resume
description: >
  Full execution protocol for MODE: RESUME -- continuing an existing approved plan safely from current state.
---

# Resume Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: RESUME
If .swarm/plan.md exists:
  1. Read plan.md header for "Swarm:" field
  2. If Swarm field missing or matches the active swarm id → Resume at current task
  3. If Swarm field differs (e.g., plan says "local" but the active swarm id is "cloud"):
     - Update plan.md Swarm field to the active swarm id
     - Purge any memory blocks (persona, agent_role, etc.) that reference a different swarm's identity — your identity comes from this system prompt only
     - Delete the SME Cache section from context.md (stale from other swarm's agents)
     - Update context.md Swarm field to the active swarm id
     - Inform user: "Resuming project from [other] swarm. Cleared stale context. Ready to continue."
     - Resume at current task
If .swarm/plan.md does not exist → New project, proceed to MODE: CLARIFY
If new project: Run `complexity_hotspots` tool (90 days) to generate a risk map. Note modules with recommendation "security_review" or "full_gates" in context.md for stricter QA gates during Phase 5. Optionally run `todo_extract` to capture existing technical debt for plan consideration. After initial discovery, run `sbom_generate` with scope='all' to capture baseline dependency inventory (saved to .swarm/evidence/sbom/).
