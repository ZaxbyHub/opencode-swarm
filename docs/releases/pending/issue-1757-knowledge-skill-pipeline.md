# Knowledge pipeline and explicit skill clustering

- `skill_generate` now treats explicit `source_knowledge_ids` as a single requested thematic cluster. Automatic generation still uses semantic clustering, but caller-provided IDs no longer fragment into separate one-entry draft skills.
- Agents that can call `knowledge_recall` can now file `knowledge_receipt` audit events, and coder/reviewer/test-engineer prompts explicitly require a receipt after recalled or injected traced knowledge.
- Curator phase and post-mortem recommendations now resolve unique 8+ character knowledge-ID prefixes, skip ambiguous prefixes, and preserve directive actionability fields so actionable new recommendations can enter the active knowledge store instead of always being quarantined.
- Delegate directive injection now runs for delegated-agent Task calls as well as architect-originated calls, closing the coder/reviewer recall-to-receipt gap.
- `knowledge_recall` results now include `score_breakdown`, linked knowledge stores warn on orphaned local `.swarm/knowledge.jsonl` files, and post-mortem reports record freshness, plan-context, and knowledge-action ID verification sections.
