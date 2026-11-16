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
- `jwt` — whole three-segment JWTs. The HEADER segment is base64url of `{"…`
  (so it starts with `eyJ`) and is length-bounded to 10–1024 chars; the
  PAYLOAD segment is any base64url run (≥1 char) and the signature is
  ≥10 chars. The payload is deliberately NOT required to be a JSON object:
  an empty claims object encodes as `e30`, not `eyJ` (and a `null`/string
  payload encodes as `bnVsbA`/`Ingi`), so requiring `eyJ` there would miss
  those tokens. **Disclosed bound (verified):** an unbounded header segment
  made the regex quadratic on a dense `eyJ-` run at the shell site, which
  has no input-length bound and redacts BEFORE the audit truncation (measured:
  256 KB took 30.7–33.3 s at the unbounded arm; 150–229 ms at the bound), so
  a JWT whose header segment EXCEEDS 1024 chars is NOT matched by this arm
  at either site, and the base64 fallback arm's class excludes base64url's
  `-`/`_`, so such a token is not eliminated by a fallback either. A JWS
  that carries an `x5c` certificate chain (RFC 7515 §4.1.6 — e.g. an Apple
  App Store Server or Android attestation signed payload) routinely has a
  header of 1.2–5 KB, so this shape IS produced in practice: the header is
  TYPICALLY caught by the base64 arm (that arm's class excludes base64url's
  `-`/`_`, so a header whose long run carries those characters is not), but
  the PAYLOAD and the SIGNATURE survive in clear text at both sites in a bare
  placement (e.g. `echo <jwt> | jq`); a key/value placement (`token=<jwt>`)
  is still caught by the generic credential arm at the shell site. The `jwt`
  family is NEW in this change — at the PR's base neither site patterned a
  JWT at all, so no JWT (long header or not) was covered there — but the
  coverage gap is real and is tracked in issue #3723 (the bound stays; the
  gap needs a single-pass tokenizer that does not scan per start position).
- `azure` — CONTEXTUAL only: connection-string `AccountKey=<base64>` spans
  collapse to the bare `[REDACTED:azure]` placeholder. The arm is
  case-INSENSITIVE (`accountKey=`, `ACCOUNTKEY=`), matching Azure's
  case-insensitive connection-string key parsing
- `base64` — the ≥80-char mixed-class base64 arm now also runs at the DISPLAY site
  (previously shell-only); hex-only runs (SHA digests), uppercase-hex runs, and
  sub-80 payloads stay visible at both sites

Family resolution is order-correct: the anthropic/openrouter shapes evaluate
BEFORE the openai shape in the mirror's sequential chain and win the display
sweep's identical-span selection, so `sk-ant-api03-…` and `sk-or-v1-…` tokens now
carry their correct provider labels. The widened corpus is pinned at both sites by
a new sibling parity suite (prose elimination, family placeholder, and
mirror-parity loops) alongside the existing #3165 suite, which is unchanged.

**Disclosed bound (header placements):** which placeholder a credential gets
depends on the placement AND on the site — the two sites do NOT apply the same
context arms. The executed behaviour (a `gsk_…` token; synthetic material):

| placement | display sweep | shell mirror |
| --- | --- | --- |
| `Bearer <token>` / `Basic <token>` | `Bearer [REDACTED:groq]` (FAMILY) | `Bearer [REDACTED]` (generic) |
| `-H "Authorization: Bearer <token>"` | `-H "Authorization=<redacted>` (generic) | `-H "Authorization: [REDACTED]"` (generic) |
| `Authorization: Bearer <token>` | `Authorization=<redacted>` (generic) | `Authorization: Bearer [REDACTED]` (generic) |
| `Authorization: <token>` (bare) | `Authorization=<redacted>` (generic) | `Authorization: [REDACTED:groq]` (FAMILY) |

The display site has a generic credential-KV arm (a key followed by `:` or
`=`) but NO standalone Bearer/Basic arm, so a bare `Bearer <token>` is owned
by the FAMILY sweep there; the shell mirror has both a standalone Bearer/Basic
arm and an `-H` arm, so it owns those with the generic placeholder. A BARE
`Authorization: <token>` placement is the mirror image: the display KV arm
takes it, the shell site has no key-value arm for it and applies the family
label. At base the shell site left that token in CLEAR TEXT, so the family
label there is new, not byte-identical to base. The TOKEN is eliminated at
both sites in every shape; only the placeholder label differs by site and
placement. The per-family placeholder contract covers prose/bare placements
(the placement class with no adjacent key/scheme context the context arms can
match); pinned as intended by
tests/unit/failures/redaction-bounds-pins-3710.test.ts.

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
- `src/review/engine.ts` — the auto-review / final-review dispatch failure
  detail (`evidence.review.error` -> `.swarm/evidence/<phase>/auto-review.json`
  and the core events log). Sanitized AFTER the `isQuotaError` classifier has
  read the raw value, so quota/failover classification is unchanged
- `src/epic/phase-readiness.ts` — the Epic phase-review dispatch-failure
  reason (`.swarm/evidence/<phase>/epic-phase-review.json`). Sanitized AFTER
  the transient/permanent `classify` callback has read the raw message, so
  the retry classification is unchanged

**Disclosed bound (evaluation `failureCode`):** the evaluation dispatcher's
sanitized error is persisted as `failureCode`, a schema-capped 160-char field.
Redaction can LENGTHEN a message (a URL becomes `<url:hash>`, a credential
value becomes `<redacted>`), so the persisted value is sliced to the schema cap
at the consumer seam — the run's schema parse no longer fails and the whole
evaluation run is no longer discarded over an over-long failure string. The
pre-existing 160-char cap itself is unchanged; changing it is a schema
decision and is proposed as a follow-up (not yet filed).

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
post-collapse unrewritable forms (e.g. `/../bar`) AND any residual parent
segment reject loudly instead of hanging or emitting a traversal-bearing path.
The residual check is SEGMENT-aware and identical in both siblings: a sole
`..` segment, a leading `../`, an interior `/../`, and a terminal `/..` are
all rejected (`a/../../b`, `foo/..`, `..`), while a `..` INSIDE a segment
(`a..b.ts`) is not a parent segment and still normalizes. Benign inputs
(`src/utils/logger.ts`, `a/b/c.ts`, `../x/y.ts`) are unchanged.
