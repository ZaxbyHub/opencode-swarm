## What changed

Completed the PR-review transition authority wire-or-retire census (issue
#2512, Workstream H): every declared `PrReviewEvent` member now either has a
production dispatch site or is deliberately retired with its replacement
authority documented.

- **Wired four transitions into their production adapters.** Base admission
  (`enforcePrReviewBaseDimensionsWhileLocked`), coverage finalization
  (`completePrWorkflow`), critic settlement (`assertPrReviewTerminalReady`), and
  armed recovery (`recoverArmedPrWorkflow`) now dispatch through
  `reducePrReviewEvent`, apply the returned state, and map typed rejections to
  the existing BLOCKED messages. The duplicated inline armed-recovery
  cancellation write is gone; the persisted record is byte-identical.
- **Retired six declared-but-never-dispatched events** whose rules live at
  richer executor boundaries: `transcript_evidence_presented` (receipt
  downgrade protection), `provider_terminal_observed` (evidence
  classification), `lane_cancelled` (operator cancellation),
  `publication_armed` / `publication_published` (publication arming and
  settlement), and `reviewer_authorization_consumed` (the storage-backed
  re-entry reserve — a pure reducer cannot independently observe a concurrent
  storage mutation). The rejection-code union dropped the codes only those
  cases emitted and gained `no_coverage_requires_incomplete`.
- **Critic coverage now means a valid settled result.** The
  `critic_result_recorded` payload changed from a flat
  `criticConfirmedFindingIds` list to `criticSettledReceipts`
  (`{findingId, status, reviewerRowDigest}`): UPHELD, DOWNGRADED and DISPROVED
  each satisfy assigned coverage; NEEDS_MORE_EVIDENCE is nonterminal (refused
  at the transport schema) and never satisfies it. Receipts are bound to the
  current authoritative reviewer-row digests.
- **Coverage finalization enforces the production verdict matrix at the
  transition authority**: NO_COVERAGE may only finalize INCOMPLETE (previously
  the reducer admitted REQUEST_CHANGES there while the inline path refused it).
- **New CI guardrail**: `tests/unit/pr-review/reducer-adapter-authority.test.ts`
  re-runs the census on every run — declaring a new union member without a
  production construction site fails the suite. Registered-path critic
  settlement evidence for #2585 lives in
  `tests/unit/pr-review/registered-critic-settlement-paths.test.ts`.
- **Lifecycle documentation**: `docs/pr-review-transition-authority.md` is the
  16-row wire-or-retire table, the binding-field authority split
  (session/workflow/head/generation in the reducer; revision digest at the
  executor that resolved it), and the PR_REVIEW-vs-PR_FEEDBACK separation.

Refs #2512
