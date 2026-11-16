---
issue: 3314
---

# Stage A trusts base-identical compound package scripts

## What

`/swarm pr-feedback` Stage A no longer hard-fails on repositories whose `build`,
`typecheck` or `lint` package script is a compound shell string (`&&`, `|`, `;`, …).
When the caller supplies `base_ref`/`base_sha` provenance and the script text is
byte-identical at that immutable merge base, discovery now returns the normal
`package.json#<script>` obligation instead of throwing
`BLOCKED: Stage A opaque package script …`. This repository itself was wedged: its
own `build` script is an `&&` chain and no `.pr-validation.json` exists, so every
content-changing PR-feedback run died on its first Stage A call.

The trust comparison is a single-script string equality against the base
manifest text (same trust root as the `.pr-validation.json` contract path, but
narrower than that path's whole-file comparison). A script whose working-tree
text differs from the base text, a missing or unparseable base manifest, a
non-string script value on either side, or absent provenance all stay BLOCKED.
The Stage A check must still select the script exactly through the package
manager (`bun run build`), and the BLOCKED text for the remaining untrusted case
now names remedies that are actually reachable: authorize a validator that is
already byte-identical at the merge base (a validator the PR adds is not
trusted), supply merge-base provenance and keep the script byte-identical, or
de-compound/keep the script out of the PR.

Trust-floor disclosure (round-2 review): the `base_ref`/`base_sha` identity is
**caller-asserted** — Stage A verifies only internal merge-base consistency
(`merge-base(base_ref, pr_head_sha) == base_sha`), and PR_FEEDBACK has no
durably bound merge base to verify against (only PR_REVIEW binds one). A caller
that names a PR-internal ref can therefore make a PR-added compound script
trusted. The Stage A receipt now records `baseRef`/`baseSha` with
`baseVerification: 'caller-asserted'` (or `'none'`) so any such substitution is
detectable downstream instead of silent; a durable PR_FEEDBACK base binding
remains open work. Two more screened-shape limits: npm lifecycle hooks
(`prebuild`, `postlint`, …) are not screened by the category name match, so a
PR-added lifecycle hook is never base-checked while the real `npm run build`
would execute it; and base reads are resolved relative to the session directory
(`./`-prefixed `git show` paths), so a subdirectory-rooted session can no longer
trust its manifest against the toplevel base manifest.

Recorded residual: base-identical compound text is trusted without the
plausibility screen simple scripts pass, so a repository whose merge base
already carries a trivially-passing compound script gets a vacuous Stage A
green; and sibling scripts/files the trusted script invokes (`bun run clean`,
`scripts/*.ts`) remain repository content, as they already are for simple
scripts. One inherited path-shape limit (fail-closed, applies to the manifest
and the `.pr-validation.json` contract read alike): workspaces whose directory
or file names fall outside the git snapshot reader's path pattern (scoped
packages like `@acme/ui`, spaced or Unicode directory names) stay BLOCKED even
when base-identical; every conforming path shape — including dot-initial
segments such as `.pr-validation.json` and `.github/` — reads correctly at the
root and at depth. For discovery-scanned workspaces of the non-conforming
shape (anything directly under
`packages`/`apps`/`services`/`libs`/`crates`) there is no `.pr-validation.json`
escape either — the contract read fails the same path pattern — so the way out
is renaming the directory to a conforming shape or making the script
non-compound.

## Why

Issue #3314 (wedge-audit slot L1, tracker #3309): the opaque-script throw ran
before every other Stage A precondition, leaving no in-band path to completion —
the defining wedge of the audit program.

## Verification

Nine frozen acceptance checks (C1-C9) in trace
`3314-stage-a-trusted-package-scripts`: five DISCRIMINATING checks reproduce the
BLOCKED throw at base and pass after the fix (discovery-level, this repository's
verbatim `build` text, end-to-end receipt recording, remedy text, exact script
selection); four PRESERVING checks pin the unchanged floors (PR-modified and
base-absent scripts stay BLOCKED, no-provenance stays BLOCKED, simple and
non-matching scripts unchanged, the `.pr-validation.json` contract path
unchanged). Round-2 additions, each mutation-proven: a base manifest that parses
but omits the script key stays BLOCKED (the `baseScript === undefined` mutant is
killed); a subdirectory-rooted session consults only cwd-relative base paths
(dropping the `./` prefix fails the nested and subdirectory suites). The
git-snapshot reader's path guard admits the `./` prefix so the cwd-relative
reads execute against real git, pinned by an UNMOCKED integration suite that
runs the real reader and the real merge-base resolution over a real repository
fixture (admits `./` and bare paths, still rejects `../` and unknown
revisions). The Stage A receipt accepts 40- and 64-hex object ids, matching the
repository's OID convention. Full stage-a suite battery green.
