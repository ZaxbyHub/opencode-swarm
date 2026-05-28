---
name: discover
description: >
  Full execution protocol for MODE: DISCOVER -- read-only repository discovery and governance/context mapping.
---

# Discover Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: DISCOVER
Delegate to the active swarm's explorer agent. Wait for response.
For complex tasks, make a second explorer call focused on risk/gap analysis:
- Hidden requirements, unstated assumptions, scope risks
- Existing patterns that the implementation must follow
After explorer returns:
- Run `symbols` tool on key files identified by explorer to understand public API surfaces
- For multi-file module surveys: prefer `batch_symbols` over sequential single-file symbols calls
- Run `complexity_hotspots` if not already run in Phase 0 (check context.md for existing analysis). Note modules with recommendation "security_review" or "full_gates" in context.md.
- Check for project governance files using the `glob` tool with patterns `project-instructions.md`, `docs/project-instructions.md`, `CONTRIBUTING.md`, and `INSTRUCTIONS.md` (checked in that priority order — first match wins). If a file is found: read it and extract all MUST (mandatory constraints) and SHOULD (recommended practices) rules. Write the extracted rules as a summary to `.swarm/context.md` under a `## Project Governance` section — append if the section already exists, create it if not. If no MUST or SHOULD rules are found in the file, skip writing. If no governance file is found: skip silently. Existing DISCOVER steps are unchanged.
