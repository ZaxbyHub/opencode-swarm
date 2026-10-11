# Contributing: issue format codified as executable contracts

## What changed
- CONTRIBUTING.md gains a "Filing issues — issues are executable contracts" section defining the issue format the tracer workflow consumes: EARS acceptance-criteria grammar (WHEN/THE SYSTEM SHALL, plus Ubiquitous/If-Then/While/Where variants), the five required per-AC sub-bullets (class/argv/expect/files/why), the DISCRIMINATING / NEW-SURFACE / PRESERVING verification-class semantics, evidence rules (full-SHA permalinks, VERIFIED/INFERENCE epistemic labels, inline correction preservation, prior-art reconciliation), the extended-section menu for design-heavy issues, workstream program conventions ([Workstream X] PR n of m, one issue = one PR, Sequence cross-links), and a filing checklist. Grounded in EARS (Mavin/Rolls-Royce) and positioned against GitHub Spec Kit.
- New `.github/ISSUE_TEMPLATE/issue.md` scaffold mirroring the contract.

## Why
Issues were the only contract in the pipeline not documented anywhere; the format was tribal knowledge spread across repos. Codifying it makes every filed issue freezable into acceptance checks without reformatting.

## Migration
None — documentation only. Existing open issues are grandfathered; new verifiable issues should follow the contract.
