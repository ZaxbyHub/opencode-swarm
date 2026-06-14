# docs: refine skill guidance for review follow-up and testing

This PR tightens two skill documents:

1. `swarm-pr-feedback` now calls out common review-verification traps such as
   stale line refs, import/export path mismatches, precedence claims, and
   cache/state order issues.
2. `writing-tests` now includes guardrail-authority-specific advice for avoiding
   masked assertions, proving case-sensitive glob behavior, and testing cache
   priming order in both directions.

Why:
- These patterns came up during review follow-up on issue #1303 and are easy to
  mis-handle without explicit guidance.
- The goal is to make future review-response and test-writing passes more
  evidence-driven and less likely to accept a superficially passing assertion.

Migration:
- No migration required.

Breaking changes:
- None.

Known caveats:
- The added guidance is intentionally narrow and tied to the repo's review and
  authority-testing workflow. It is not a general-purpose testing policy.
