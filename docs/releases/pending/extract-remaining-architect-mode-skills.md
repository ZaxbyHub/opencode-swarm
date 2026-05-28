## Summary

- Extract remaining architect mode protocols from the monolithic architect prompt into mirrored `.opencode` and `.claude` skill files.
- Covered mode skills: brainstorm, specify, clarify-spec, resume, clarify, discover, consult, pre-phase-briefing, council, deep-dive, issue-ingest, plan, critic-gate, execute, and phase-wrap.
- Keep `src/agents/architect.ts` as lightweight mode dispatch stubs that load the relevant skill on demand, with hard constraints retained in each stub.
- Move the retrospective gate protocol into the phase-wrap skill so retrospective evidence rules live with phase-boundary execution.
- Remove unresolved renderer placeholders from runtime-loaded skill files and express delegated targets as the active swarm's role agents.
- Fix issue-ingest delegation so non-mega swarms do not route to hardcoded `mega_explorer` or `mega_sme`.
- Add regression coverage for every extracted mode skill, mirror parity, architect-stub slug drift, unresolved QA gate placeholders, unresolved agent-prefix placeholders, and prompt tests that validate protocol content from the skill files.
- Local validation includes 121 focused skill protocol tests, 382 focused architect/factory prompt tests, Biome, typecheck, build, and the Node ESM dist import smoke test.
