# Method Provenance (state of the art)

The quality methods in this skill are grounded in current agentic-repair and agent-reliability research, adapted to a plan-first, evidence-first, full-resolution workflow:

- Hierarchical file → function → line localization, multi-sample candidate patches, and validate-then-select repair: Agentless (Xia et al. 2024, https://arxiv.org/abs/2407.01489).
- Reasoning-guided, explanation-ranked fault localization (a causal explanation per candidate, not surface similarity): RGFL (https://arxiv.org/pdf/2601.18044); structure/spectrum-aware search: AutoCodeRover (https://arxiv.org/abs/2404.05427).
- "Tests passing is plausible, not correct" / patch overfitting: patch-correctness survey (https://dl.acm.org/doi/10.1145/3702972).
- Self-consistency across independent passes: Wang et al. 2022 (https://arxiv.org/abs/2203.11171).
- A fresh independent context refutes the result (the doer is not the grader) and evidence-grounded reporting (show the command and its output, do not assert success): Anthropic, "Effective harnesses for long-running agents" (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- Plan → implement → review separation as explicit quality gates: Anthropic, "Building Effective Agents" (https://www.anthropic.com/research/building-effective-agents).
- Escalate when the issue lacks reproducible steps or acceptance criteria (issue clarity predicts resolution success): GitHub coding-agent best practices (https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent/best-practices-for-using-copilot-to-work-on-tasks).

Recurrence-class eradication (Phase 4.2) generalizes the "fix the class, not the instance" principle: a single-site repair that leaves the defect class searchable and reintroducible has not closed the issue's real surface. The guardrail ladder (static rule → type constraint → runtime/trust-boundary assertion → CI check → documented invariant + regression family) prefers machine-enforced prevention over human vigilance.
