---
name: clarify
description: >
  Full execution protocol for MODE: CLARIFY -- asking focused user questions when safe defaults are not enough.
---

# Clarify Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: CLARIFY
Ambiguous request → Ask up to 3 questions, wait for answers
Clear request → MODE: DISCOVER
