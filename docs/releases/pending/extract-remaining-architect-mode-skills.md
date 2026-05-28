## Summary

- Extract remaining architect mode protocols from the monolithic architect prompt into mirrored `.opencode` and `.claude` skill files.
- Keep `src/agents/architect.ts` as lightweight mode dispatch stubs that load the relevant skill on demand.
- Add regression coverage for every extracted mode skill, mirror parity, and prompt tests that validate protocol content from the skill files.
