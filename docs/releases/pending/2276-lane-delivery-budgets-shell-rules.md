# Dynamic PR-review lane budgets and pre-seeded shell rules

## What changed

`/swarm pr-review` lanes now receive an explicit, workload-derived final-response budget and the read-only shell rules up front, in the controller-appended `[CONTROLLER-BOUND PR WORKFLOW CONTRACT]` block (issue #2276; stacks on the #2258/#2272 recovery work).

- **Per-lane-kind budgets** replace the one-size-fits-all 12,000-character cap for `swarm-pr-review:*` lanes: base dimension lanes get 18,000 chars, micro family lanes 12,000 (a consolidated micro lane owning several workflow lanes at depth tiers S/M scales up 2,000 per additional owned lane, capped at 18,000; council lanes are flat 12,000 because the dispatch gate forbids multi-lane ownership on them), and reviewer/critic lanes 6,000 plus 1,500 per assigned review item — all capped at 18,000, every value safely under the 20,000-character inline preview window. `swarm-pr-feedback:*` lanes keep the previous flat 12,000-character guidance.
- **Budget discipline is stated, not implied**: only the final response is bounded — investigation and tool-call volume are explicitly uncapped; terminal machine-readable rows are spent first and must always fit with room to spare; verify each target exactly once; never restate a verification; emit rows the moment analysis is complete. This is the instruction whose caller-side equivalent succeeded 5/5 in the observed tier-L run where budget-less lanes lost 7 of 13 dispatches to overshoot loops.
- **Read-only shell rules are pre-seeded** into every appended contract block (PR-review and PR-feedback modes alike): one standalone command per shell call — no pipes, no `&&`/`||`/`;`, no redirects or command substitution — with the three tolerated forms and the "prefer Read/Glob/Grep" guidance. Previously each lane rediscovered these rules through 2–4 rejected tool calls.
- The `swarm-pr-review` prompt templates now defer to the controller-declared budget when one is present.
- New regression coverage pins the budget derivation (five distinct sizes, item-count and owned-lane scaling with the ceiling), the budget/shell paragraph content in every mode, and re-confirms #2272's end-to-end projection pin (the ledger-to-collect-receipt `truncated-preview-durable-artifact` disclosure in `dispatch-lanes-pr-review-verdict-transport-recovery`) stays green alongside the new guidance.

## Why

The tier-L review postmortem (#2276) showed lower-tier orchestrator lanes overshoot without an explicit budget (147k–162k characters of restated verification) and waste calls on rejected compound commands. With #2272 already trusting digest-verified artifacts over preview truncation, the remaining fix is to tell lanes the delivery contract up front so conformance does not depend on trial and error.

Closes #2276.
