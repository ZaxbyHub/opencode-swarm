# Skill-frontmatter pre-existing hardening: quote-aware comment strip, CRLF-tolerant split, staleness shadowing always runs

## What changed

Pre-existing defects in the skill-frontmatter pipeline — surfaced by the
PR #3387 review cycle and explicitly approved as a follow-up — are fixed,
plus hardening from this PR's own follow-up review:

- The drift-check `skill-frontmatter` detector's comment stripping is now
  quote-aware: a `#` inside a balanced quoted scalar (`[a, "b # c"] # note`)
  is content, so the value still triggers the flow-collection check that a
  value trailing comment previously escaped. A
  quote opens only at a value start — after a flow-element boundary, or
  after `:` only when whitespace follows (the colon in a plain flow scalar
  like `[a, b:'c]` is content, so its quote never opens and a trailing
  comment still strips). A doubled `''` inside a single-quoted scalar is
  honored as the YAML escape (`'it''s # x'` stays quoted through the `#`),
  and an unterminated quote (malformed input) falls back to the naive
  strip so that class of malformed value still fires the way it did before
  quote-awareness. A `#` at value start remains a comment-only value (no
  finding), and a comment-only child followed by `- item` lines now raises
  the YAML-sequence error (PRR-011c) it deserves.
- `splitSkillFrontmatter` is CRLF-tolerant: line endings normalize before
  the fence scan, so a CRLF file returns real frontmatter/body slices
  instead of an empty split. Previously every bounded frontmatter surgery
  (version bumps, status flips) silently no-op'd on CRLF files while the
  skill reviser's revision notes still claimed a bump the file never
  received. Digest values for LF files are unchanged; for a CRLF file the
  runtime stamp-verification input changes from the whole-file hash (which
  never matched the body-derived stamp) to the body-only digest — the same
  value the LF path and the stamp writer use, so CRLF checkouts verify
  instead of falsely reporting stale. Returned slices are LF — the repo's
  checked-out policy.
- The `user-global-skill-staleness` detector's user-global shadowing
  comparison now runs regardless of the repo-side stamp state. Previously a
  missing or stale repo stamp `continue`d past the loop — exactly the
  situation where the canonical body is least vouched for — letting a stale
  user-global copy escape the shadowing notice. The repo-side stamp warning
  itself is unchanged.
- `insertStamp` (the stamp script's insertion fallback) no longer injects a
  stamp into skill BODY text: for a fence-less skill the whole-file
  `\n---\n` search used to find the first body horizontal rule. The helper
  now fails closed on absent frontmatter so the script's existing guard
  skips the slug with an actionable message instead of writing a
  stamp-shaped line into body text.

## Why

All of the underlying defects pre-date this PR (each probe-confirmed at the
merge base) and were approved as a follow-up rather than expanded into an
already-large diff; the quote-strip hardening beyond the original fix comes
from this PR's own review round.

## Verification

- Battery: `drift-check-frontmatter-followups-3387.test.ts` (15 tests: the
  original 8 — quoted-hash flow collection, apostrophe plain scalar,
  bare-scalar trailing comment, quoted-hash-clean, inline quoted hash, and
  the three staleness combinations — plus 7 from the follow-up review: both
  colon-in-plain-scalar shapes, the unterminated-quote fallback, doubled
  single-quote fire and clean, the fully-quoted inline pin, and the
  comment-only-child YAML-sequence route),
  `skill-contract-digest-crlf-3387.test.ts` (6 tests: CRLF slices, digest
  parity, no-fence passthrough, stamp parity, reviser version bump and
  inline canonicalization on CRLF files), and
  `stamp-skill-contracts-insert-stamp-3392.test.ts` (3 tests: fence-less
  body rule returned unchanged, close-fence insertion, metadata-child
  insertion). On the pre-fix base, 8 of the 14 original new tests failed
  (the defects); the other 6 pass at base as regression guards for behavior
  that was already correct, and the edited #2859 pin plus its new CRLF case
  also failed at base. Of the follow-up-review tests, the two colon shapes,
  the unterminated fallback, and the doubled-quote fire test fail on the
  pre-hardening quote-aware strip; the doubled-quote clean, fully-quoted
  inline pin, and sequence-route tests guard behavior that was already
  correct at the pre-hardening head (the sequence route itself is new at
  this PR — it did not exist at base).
- The pre-existing #2859 suite's byte-pin on the old no-normalize return
  was updated to the documented normalized contract, with a new CRLF-slice
  case.
- Focused batteries green; `typecheck`, `drift:check --enforce`, and the
  stamp script (ok ×4) all exit 0.

## Notes

- Revised CRLF skill files are rewritten with LF line endings (the repo's
  canonical checkout form); a CRLF skill copy whose body matches canonical
  is no longer reported stale.
- The skill-scoring flow-map parser keeps its documented bounded-subset
  behavior on exotic-but-valid shapes (it fails closed); only the detector
  strip gained base-parity fallback — and that fallback covers unterminated
  quotes only. A malformed value whose quotes close around the comment
  (e.g. `['a] # b' x`) stays unstripped, the same documented bounded-subset
  class as the parser; no tracked skill file exhibits the shape.
