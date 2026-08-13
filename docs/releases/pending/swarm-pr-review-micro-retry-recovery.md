# PR-review micro retry recovery

Profile A PR reviews now document the controller contract in one concise early
reference, including the runtime-owned base and micro lane IDs, canonical row
schemas, and exact phase ordering. The first micro dispatch supplies and freezes
the complete trigger-evaluation ledger; any later same-session micro batch,
including a retry, may reuse that frozen ledger without resending it, while any
explicitly supplied copy must remain exact.

Base and micro/council explorer prompt templates are now separate, and the skill
clarifies that candidate and clean rows must be emitted as unfenced plain text.
Markdown fences in the documentation are examples only and are not machine
evidence.

The final PR-review artifact writer now derives its severity validation from
the canonical candidate vocabulary, so valid `INFO` findings persist without
being rewritten to `LOW`.

No migration or configuration change is required. There are no known caveats.
