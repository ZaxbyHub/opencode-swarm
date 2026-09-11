# Safer repo-map scopes and workflow evidence

## What

- Bound and validate multi-file repo-map requests before loading the repository graph, with schema/help parity for `blast_radius`, `preflight_packet`, `diff_context`, `test_pack`, and `retrieve`.
- Report unsupported `symbol_search` language filters explicitly while retaining bounded results.
- Make explorer, architect, and reviewer prompts invoke the canonical repo-map actions with direct-source verification and fallbacks.
- Make Go import extraction comment-aware so quoted text in line/block comments cannot create graph edges.
- Bound multi-source graph and impact resolution, expose advisory estimates, and refuse empty mutation selections.
- Add cache-v2 test-content invalidation and explicit cache-status evidence, plus bounded mutation selection from either impact results or explicit files.
- Treat Python and Ruby comment forms equivalently during mutation analysis so commented code cannot create executable candidates.

## Why

Large or malformed scopes should fail closed before graph I/O, while bounded impact estimates and cache-status evidence keep analysis honest about what was inspected. Comment-aware import and mutation analysis prevents false impact or mutation candidates across supported languages.

## Migration

No breaking changes. Existing repo-map actions, import forms, and mutation workflows remain supported; callers exceeding bounded scopes or providing no mutation candidates receive a safe refusal with actionable status evidence.
