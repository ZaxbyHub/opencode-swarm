---
issue: 3840, 3844, 3701, 3899
---

# Persisted-redaction widening: training vault bare-token families, read-compatible versioning, and evidence/forge boundary redaction

## Summary

Two security gaps closed in one delivery. First, the training-content redactor
(`src/training/redact.ts`) gains the bare well-known credential VALUE families
(anthropic, openrouter, openai, github, aws, slack, google, groq, jwt, base64
with the mixed-class guard, azure `AccountKey=`) mirrored from the shell site,
plus the shared JWS scanner (`src/utils/jws-redaction.ts`). The scanner spans
and the bare arms are collected together and MERGED into disjoint ranges, so an
overlapping arm can neither strand a tail nor drop a head. A bare provider
token of one of those families, in prose, no longer reaches the persisted
training vault. The redaction version moves to 2 with a READ-COMPATIBLE
contract: the vault record schema accepts every version 1..2 (pre-v2 records
stay valid, exportable, and — because the expiry sweep now RETAINS
version-only-quarantined lines while purging only expired/malformed/other-invalid
ones — survive rewrites; the physical byte quota is preflight-exact and counts
every retained byte). The consent surface treats `redaction_version` as
informational redactor provenance (the authorization terms are unchanged by a
redactor bump, so older consents stay valid); the export manifest reports the
SOURCE redaction versions represented by the included records SEPARATELY from
the floor every emitted record was verified at, every exported record is
re-redacted by the running redactor (the AT-REST bytes stay as they are until
the user elects migration), and an export that cannot safely redact a record
publishes nothing. Second, the review and forge evidence boundaries gain a
shared superset redactor (`src/security/evidence-redaction.ts`: `redactSecrets`
∪ display bare families ∪ credential-placement shapes ∪ URL-credential
stripping ∪ the shared JWS scanner) applied BEFORE durable writes and outputs:
auto-review evidence, review receipts, the forge event queue (every rewrite
path), the agent wake message, the subscriber advisory construction point, the
PR-feedback loop terminal reasons, the gh-evidence tool result, the published
PR-review submission body, the findings/handoff artifacts (with a salted HMAC
raw-replay identity sidecar preserving exact-replay semantics after redaction),
finding-policy synthesis, and the post-abort partial export.

## Semantics decisions

- Consent compatibility: tolerant-read (v1 consents stay valid under the v2
  redactor and capture continues; provenance semantics documented in the
  consent preview and docs/commands.md). The redaction version is
  informational provenance, NOT a consent-terms boundary — the terms
  (purpose, content classes, quotas, retention, expiry) are the authorization
  surface.
- Export manifest: the SOURCE redaction versions represented by the included
  records are reported separately from the floor every emitted record was
  verified at (the running redactor, because every exported record is
  re-redacted on output). Empty exports carry the running version.
- Already-stored v1 content: document-and-retain with a truthful remediation
  runbook (docs/training-vault-remediation.md: already-stored v1,
  append-triggered sweep with no timer guarantee, exports + copy-outside
  before withdrawal, credential ROTATION as the real remedy, downgrade
  procedure). The EXPORT path re-redacts legacy records on output; the
  at-rest record is never rewritten unless the user opts into migration.

## Safe downgrade (vault)

A downgrade after v2 records exist reinstates the old literal reader and the
old sweep-on-rewrite behavior: v2 records would quarantine `schema_invalid`
and then be physically deleted at the next 256-append sweep. The safe
procedure: **export the vault, copy the export outside plugin control
(withdrawal revokes plugin-side exports with REVOKED.json markers), withdraw
consent, withdraw-purge the vault content, then downgrade** — or **accept the
loss** and let the next sweep delete the v2 records. The replay-identity sidecar
and the handoff claim are inert under downgrade (the downgraded build neither
reads nor writes them), so they can be removed WHILE the downgraded build is
in use — but keep them if an upgrade is planned: with the sidecar gone, the
next identical retry falls back to comparing the incoming raw payload with
the PERSISTED rows, and for REDACTED rows the two forms no longer compare
equal, so an identical raw retry can be refused. Full runbook:
docs/training-vault-remediation.md.

## Known bounds

- The training redactor still does NOT mirror the display site's Cf/DI
  condensed-view sweep (two-view fill-tolerance) — same bound as pre-#3882 at
  the memory site; the family corpus and JWS scanner are mirrored, the
  condensed-view machinery is not.
- The training redactor still does NOT compose the `redactSecrets` floor, so
  a PEM private-key block and the Stripe (`sk_live_`/`rk_live_`) and GitLab
  (`glpat-`) families are still stored verbatim by the TRAINING path (the
  evidence path redacts them). Pre-existing; tracked by the follow-up issue
  filed with this PR.
- The training capture bound (4096 characters) is applied BEFORE the
  redaction, so a credential that STRADDLES the bound leaves its prefix in
  the vault (the token itself never does — the prefix is shorter than every
  arm's minimum, so it is not usable). The order is deliberate: bounding
  after the redaction would let a placeholder outgrow the bound and collapse
  two different captures onto one record id.
- Two persisted-evidence sinks are still outside the #3844 boundary set: the
  council evidence writers (`src/tools/write-final-council-evidence.ts`,
  `src/tools/submit-phase-council-verdicts.ts`) and the task-level council
  evidence writer (`src/council/council-evidence-writer.ts`). They persist
  model-authored free text raw. Pre-existing; tracked by the follow-up issue
  filed with this PR, and the PR body's coverage claim is narrowed to the
  enumerated boundary set.
- Legacy pre-fix queue events, receipts, and review artifacts on disk keep
  their historical bytes (future-write redaction only; operator remediation
  = delete stale `.swarm` artifacts if desired).
- The replay-identity salt and handoff claim are published by LINKING a
  complete, fsync'd temp file into place, so the target path never exists in
  a partial state. A filesystem without hard links (FAT/exFAT, some network
  shares) cannot link, and salt creation then fails closed there — the
  pr-review findings and handoff writes refuse rather than write an
  unprotected file.
- `redactSecrets`' family set remains the persisted-store floor at its 12
  existing consumer sites; the new superset redactor is applied at the
  #3844-named boundaries, not retroactively across every store.
- Two review findings that differ ONLY in the secret they quote collapse into
  one candidate once the secret is redacted (the count is preserved in the
  finding's `duplicate_count`). A persisted review cannot tell them apart
  without persisting the secret, and the validator receives the same
  redacted text either way.
- The two redactors are independently maintained pattern lists. The EVIDENCE
  redactor covers the TRAINING redactor's credential FAMILIES (it also
  redacts a PEM private-key block, a Stripe live key and a GitLab personal
  access token, which the training path still stores verbatim), but the two
  differ on URL handling: the training redactor replaces a whole URL, while
  the evidence path redacts the credential PARAMETERS of a URL. Every export
  re-redacts the record content; the exported redaction counters count only
  the redactions an export pass actually made.

## Replay-identity hardening

- The pr-review handoff replay identity is now CLAIM-ONCE
  (`.swarm/pr-review/<runId>/replay-identity.handoff.claim`): a concurrent
  losing writer can no longer overwrite the winner's fingerprint and then
  validate its own raw summary against it — a foreign claim with different
  raw content is refused before any artifact bytes. The salt and the claim
  are published create-only via a temp+fsync+link publication, so the final
  path never exists in a partial state and an interrupted write leaves no
  corrupt artifact behind (a bare create-only open did).
- Retained version-only-quarantined vault lines no longer consume the append
  quota's maxRecords (matching the read-side status accounting); malformed
  lines still charge it. Only a record from a STRICTLY NEWER redactor is a
  version-only spare — a sub-minimum version is invalid state and keeps the
  historical purge-on-sweep class.
- The per-project quarantine journal-dedup cache is bounded (16 projects,
  FIFO eviction with journal rehydration) per the bounded-global-state
  invariant.
- Executor-level pins now cover the handoff/claim race, both comparators'
  missing/corrupt fail-closed legs, the token-bearing severity-only
  committed replay through the sidecar, post-claim sidecar-write failure,
  and same-family different-secret conflicts. The claim/sidecar residue a
  failed artifact create leaves behind is IDENTITY-RESERVING, not inert: an
  identical-raw retry succeeds through it, a different-raw retry conflicts
  (the claim is immutable for the run's life — a possibly-committed
  identity is never silently taken over); operator recovery for an
  abandoned run is archiving/deleting `.swarm/pr-review/<runId>/`.

## Redaction scan and evidence-path hardening

- The AWS secret CONTEXT arm now runs BEFORE the bare AKIA arm on the
  evidence path: the bare arm used to consume the access-key id first, so
  `redactSecrets`' context arm could never fire and the 40-character AWS
  secret next to the id survived raw. The arm redacts the SECRET alone — the
  prose between the id and the secret is left alone, because that prose can
  itself carry a credential the other arms must still see.
- The gh_evidence run METADATA (`runHtmlUrl`, `runHeadBranch`, ...) is
  redacted like `data` is — the metadata fields are copied from the raw
  parsed object, so a token in the run URL was a second leak path.
- The replay-identity rollback distinguishes an ABSENT sidecar (nothing to
  restore) from an UNREADABLE one (fail closed). A failed rollback WRITE
  leaves the sidecar in place — discarding it would throw away the identity
  of every other committed boundary. A stale key is fail-closed instead:
  the replay decision also cross-checks the PERSISTED ROWS, so a sidecar
  that still claims an uncommitted payload cannot make the next identical
  retry drop that content silently.
- The auto-review evidence path CLAMPS the fields it redacts, so a
  near-limit field that the redaction lengthens cannot fail its schema on
  read-back and lose the finding.
- The URL-credential arm is generic (any scheme character, any length) and
  scans in linear time: an unbounded or word-boundary-anchored scheme class
  restarted the scan at every word boundary, which measured 4.2 s for 64 KB
  of colon-free input.
- The shared redactor reaches a FIXED POINT, and so does the redacted-field
  form (redact, then clamp): the clamp can cut a value where a
  credential-shaped run begins, so the pair runs until its output stops
  changing. The same value is redacted more
  than once (the review evidence is redacted at assembly and again at
  persistence, the receipt is redacted again when it is persisted, and the
  forge queue re-redacts a stored message on every rewrite), so a redactor
  that changes its output on the second pass made the evidence copy and the
  receipt copy of one finding differ. The redaction now runs until the output
  stops changing, and the key/value placement arm no longer matches a value
  that starts with an existing placeholder (and it keeps the separator it
  consumed instead of gluing the surrounding words together). The loop also
  closes a single-pass leak: a bare-family credential GLUED to a preceding
  word character has no word boundary, so it is redacted once the
  neighbouring token is itself replaced. (A credential glued to a word that
  is NOT itself redacted keeps its own boundary rules — the family arms are
  anchored on purpose.)
- The persisted-store corpus runs over the WHOLE text. Its private-key arm
  needs both delimiters in ONE match, so a placeholder inserted inside a
  key block must not split the span.
- The auto-review finding identity is derived from the REDACTED content. The
  `finding_id` is a hash of the finding's title and body, and the
  evidence-integrity check re-derives it from the persisted copy; redacting
  after the id was derived left the stored id describing content that no
  longer existed, so a review finding that quoted a credential (exactly what
  a security review produces) was reported as invalid and the
  phase-completion gate failed closed on every such phase. The parsed
  findings are now redacted once, before the identity is derived, so the
  evidence, the receipt and the identity all describe the same content.
- The approved receipt's anchoring caveat is compared the way it is BUILT:
  the caveat is composed from the finding's title and its anchor rejection
  and the receipt persists the composed string after redacting it as a
  whole, so the expectation has to be composed and redacted the same way —
  composing two redacted parts can create a new credential shape, and the
  comparison used to reject every approved review with an unanchored
  finding.
- The evidence path covers the training path's >=80-character mixed-class
  base64 family, so an undotted base64 secret that the training vault
  redacts before export no longer survives in the clear in a review artifact.
  (The two redactors are not supersets of one another: the evidence path
  also redacts a PEM block, a Stripe live key and a GitLab token, which the
  training path stores verbatim, while the training path replaces a whole
  URL and the evidence path redacts the credential parameters of one.)
- The forge queue clamps the redacted event message to the bound its own
  disk schema enforces: a redaction placeholder is LONGER than the secret it
  replaces, so a message that sat exactly on the bound was pushed past it by
  the redaction and the queue write failed.
- The published PR-review body redacts the finding LOCATION (the path and
  the prose beside it) and the finding status, not just the evidence field.
  The location reaches both the published body line and the inline-comment
  path, and a review artifact written before this change can carry a
  credential in it. When the redaction changed the PATH, the finding stays a
  body-only entry — an inline comment would name a file that does not exist
  in the repository.
- The reviewer receipt's free text is redacted where the project directory
  is known: the finding's title, body and file, a LEGACY issue's `path:line`
  location, the evidence references and the structured findings of BOTH
  verdicts. The redaction happens BEFORE the receipt, the finding identity and
  the validation candidates are derived from it, so the persisted receipt and
  the identity describe the same content. The evidence references are redacted
  at the receipt boundary, which does not know the review scope's own paths —
  so a range diff's target-side path is redacted there like any other
  unresolved path (a cosmetic difference in a display string; nothing reads
  the field).
- The evidence path redacts a URL's credential PARAMETERS (`?password=…`, an
  Azure SAS `&sig=…`, an S3 `X-Amz-Signature=…`): the training redactor
  replaces a whole URL, so without the parameter names a URL-embedded
  password persisted in the clear in review evidence.
- The training export preserves the capture-time redaction history: a record
  whose credential was already replaced at capture has no new match on
  export, and overwriting the counters with the export pass's own result
  would claim that no redaction was applied to a record whose content IS
  redacted. The exported counters count only the redactions the export pass
  actually made — the training redactor no longer re-matches its own
  placeholder, so an export neither corrupts the record nor counts a
  redaction that removed nothing.
- The core-events writer fits a redacted line to its own 256 KiB bound. A
  redaction placeholder can be longer than the credential it replaces, so an
  event whose free text sat exactly on the bound was refused after the
  redaction; the refusal contract is unchanged (an event that was already
  over the bound is still refused) and the redacted, secret-free carriers
  are truncated until the line fits.
- A finding's file path is redacted only when it names NO real file: a path
  that resolves inside the project, or a path the review scope knows to be
  real (for a range diff its paths come from the resolved target commit, not
  from the current checkout), is persisted verbatim. A real repository path
  is not a secret, and redacting one would break the anchoring — the
  redactor's long mixed-class base64 rule counts `/` as a base64 character,
  so an ordinary deep path matches it, and a redacted path does not resolve,
  so the finding would silently stop blocking the phase gate. The review
  receipt's file and location are redacted by the same rule.

## Fold-in: the remaining persisted-evidence boundaries

The six census-deferred sites joined this PR: completion-verify's
persisted blocked-task fields (parsed from model-authored plan text), the
drift/hallucination/mutation evidence summaries (including the drift
critic-approval snapshot metadata), the core-events writer's free-text
carriers (detail/message/summary/reason/description redacted by default,
authority keys computed on the original event so at-most-once semantics are
unchanged), and the gate-evidence passthrough extras (redacted at the
single persist boundary; the declared structural fields pass verbatim).
A shared redactEvidenceDeep helper carries the recursive form.
