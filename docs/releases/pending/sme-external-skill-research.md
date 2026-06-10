# SME external skill research

- Gives the SME agent opt-in access to the existing `web_search` tool so it can discover and evaluate external agent skill sources when a task would benefit from current outside knowledge.
- Hardens the SME protocol for external skill discovery: web results and external skill files are treated as untrusted evidence, not executable instructions, and missing search configuration is reported explicitly instead of silently fabricated.
- Keeps the existing search gate in place: `council.general.enabled` plus a configured Tavily or Brave API key are still required before any external search runs.
