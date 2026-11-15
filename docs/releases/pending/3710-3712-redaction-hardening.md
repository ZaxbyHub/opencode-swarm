---
issue: 3710,3712
---

## Redaction-family hardening: widened bare-token corpus, persistence-boundary sanitization, and mock-target normalizer wedge fix

### Widened credential corpus at BOTH redaction sites (#3712)

`sanitizeFailureEvidenceDisplay` (display sweep, `src/failures/invocation-failure.ts`)
and `redactShellCommand` (shell mirror, `src/hooks/guardrails/helpers.ts`) now redact
these additional bare well-known credential families, each with its own
`[REDACTED:<family>]` placeholder (the rotation signal the parity suites pin):

- `anthropic` — `sk-ant-…` shapes (previously mislabeled `[REDACTED:openai]`)
- `openrouter` — `sk-or-…` shapes (previously mislabeled `[REDACTED:openai]`)
- `google` — `GOCSPX-…` (OAuth client secrets) and `ya29.…` (GCP access tokens)
- `groq` — `gsk_…` service keys
- `jwt` — whole three-segment JWTs (both leading segments start `eyJ`)
- `azure` — CONTEXTUAL only: connection-string `AccountKey=<base64>` spans collapse
  to the bare `[REDACTED:azure]` placeholder
- `base64` — the ≥80-char mixed-class base64 arm now also runs at the DISPLAY site
  (previously shell-only); hex-only runs (SHA digests), uppercase-hex runs, and
  sub-80 payloads stay visible at both sites

Family resolution is order-correct: the anthropic/openrouter shapes evaluate
BEFORE the openai shape in the mirror's sequential chain and win the display
sweep's identical-span selection, so `sk-ant-api03-…` and `sk-or-v1-…` tokens now
carry their correct provider labels. The widened corpus is pinned at both sites by
a new sibling parity suite (prose elimination, family placeholder, and
mirror-parity loops) alongside the existing #3165 suite, which is unchanged.

**Disclosed bound (header placements):** credential tokens inside Authorization/Bearer header placements are redacted by the pre-existing context arms with their GENERIC placeholders (the shell Bearer/Basic and -H header arms; the display credential-KV arm) at both sites - byte-identically to base, for every family. The per-family placeholder contract covers prose/bare placements (the placement class with no adjacent key/scheme context the context arms can match); pinned as intended by tests/unit/failures/redaction-bounds-pins-3710.test.ts.

**Disclosed bound (path-like base64 false positives):** an >=80-character
mixed-class run without `.`/`-`/`_` separators — e.g. a flattened long
mixed-case filesystem path in an ENOENT message — is redacted as
`[REDACTED:base64]` at BOTH sites (the shell site has behaved this way since
the arm shipped; the display site now matches it). Hex-only digests stay
visible at both sites.

**Disclosed split (sync tool output):** on the blocking dispatch path the
saved terminal record is sanitized, while the tool-result `error` returned to
the model still carries `syncClassifiedReason ?? formatError(error)` verbatim
(display surface, not a `.swarm` artifact). The lane-rejection artifact's
inline detail is additionally flattened to the sanitizer's 512-byte
single-line bound.

**Disclosed bound:** bare 32-hex Azure OpenAI keys are deliberately NOT patterned
— they are indistinguishable from MD5/hex digests that must stay visible
(#3712 AC3); only contextual `AccountKey=` forms are redacted.

### Redacted provider-error text at every persistence boundary (#3710)

Across the dispatch family (full-auto oversight + legacy intercept, lean
turbo runner/critic/reviewer, dispatch-lanes, and the evaluation model
dispatcher), raw provider/SDK error JSON (`JSON.stringify(<result>.error)`) and
raw `.message` text no longer reach durable `.swarm` state unredacted.
`sanitizeFailureEvidenceDisplay` is applied at the persistence seams of the
dispatch family — AFTER every transient/quota classifier read, so model failover
behavior is unchanged:

- `src/full-auto/oversight.ts` — infraReason (oversight events, phase evidence,
  run-state records, pause reasons), health-probe reasons
  (`lastRecoveryProbe.reason`), and the dispatch-failure logger argument
- `src/hooks/full-auto-intercept.ts` — legacy critic infraReason (pause reason)
  and logger arguments
- `src/turbo/lean/runner.ts` — `dispatchResult.error` (lane evidence,
  phase evidence, recovery records)
- `src/turbo/lean/integration.ts` — critic evidence (`lean-turbo-critic.json`)
  and the returned REJECTED reason
- `src/turbo/lean/reviewer.ts` — reviewer evidence (`lean-turbo-reviewer.json`)
  and the returned REJECTED reason
- `src/tools/dispatch-lanes.ts` — lane-rejection artifacts, async launch-error
  terminal records, and sync terminal records. The terminal triple
  (error/chars/truncated/digest) derives from ONE sanitized message with the
  established #2045/#2349 semantics (`error` = slice to MAX_ERROR_CHARS,
  `chars` = sanitized full length, `truncated` = the bound flag, `digest` =
  SHA-256 of the sanitized value), replacing the hardcoded `truncated: false`
  on the async path

The `oversight infrastructure failure after N attempt(s):` prefix and the
`deadline` / `opencodeClient unavailable` words survive redaction, so the
pause-reason matchers in `full-auto/recovery.ts` and `full-auto-permission.ts`
keep working. Long raw messages can be truncated by the sanitizer's internal
512-byte bound; the terminal-triple fields always describe the sanitized value.

### Mock-target normalizer wedge fix (#3710)

`normalize_mock_target` (bash lib) and `normalizeMockTarget` (TS sibling) no
longer loop forever on `//`-form paths like `foo//../bar`: duplicate separators
are collapsed before the dotdot rewrite, and a rewrite that makes no progress is
a diagnosed BOUNDED REJECTION (TS throws; bash prints a stderr diagnostic and
returns 1) — never a traversal-bearing success value.

**Declared behavior changes:** duplicate separators now canonicalize
(`foo//bar.ts` → `src/foo/bar.ts`); `foo//../bar` normalizes to `src/bar`;
post-collapse unrewritable forms (e.g. `/../bar`) reject loudly instead of
hanging or emitting a wrong path. Benign inputs (`src/utils/logger.ts`,
`a/b/c.ts`, `../x/y.ts`) are unchanged.
