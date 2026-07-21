---
category: Fixed
---

- Restored `/swarm pr-review` and `/swarm pr-feedback` bootstrap reliability:
  review architects now receive one gate-compatible exact-SHA checkout sequence
  before explorer dispatch, unsafe checkout variants fail closed with actionable
  guidance, and the first feedback bind requires a clean tracked branch whose
  upstream tip is the exact intake PR head.
- Respect user interruption during mechanically gated PR workflows. Esc-driven
  `MessageAbortedError` now pauses both response-gate and PR-monitor automatic
  wakes until a later explicit user turn. Plugin-authored wake messages carry
  exact IDs so they cannot be mistaken for that user turn, while the durable
  workflow state remains available for a deliberate continue or abort.
