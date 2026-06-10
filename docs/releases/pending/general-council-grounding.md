## General Council

- Hardened General Council research grounding for current-sensitive questions:
  `web_search` now normalizes current-intent queries, strips stale trailing
  cutoff years, applies provider freshness filters, and returns audit metadata
  for the RESEARCH CONTEXT.
- Updated council member prompts and council workflow skills so model training
  knowledge can only supply stable background context, not current facts or
  state-of-the-art claims.
- Clarified General Council config resolution across skills, commands, and tool
  errors: global `~/.config/opencode/opencode-swarm.json` is the default source
  and project `.opencode/opencode-swarm.json` is an override, so architects
  should not fail after checking only the project file.
