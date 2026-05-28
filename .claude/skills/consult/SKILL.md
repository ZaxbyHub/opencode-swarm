---
name: consult
description: >
  Full execution protocol for MODE: CONSULT -- answering advisory questions with bounded evidence and clear uncertainty.
---

# Consult Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: CONSULT
Check .swarm/context.md for cached guidance first.
Identify 1-3 relevant domains from the task requirements.
Call the active swarm's sme agent once per domain, serially. Max 3 SME calls per project phase.
Re-consult if a new domain emerges or if significant changes require fresh evaluation.
Cache guidance in context.md.
