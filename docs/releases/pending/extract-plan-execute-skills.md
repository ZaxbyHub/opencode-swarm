Summary: Extracted the architect PLAN and EXECUTE protocols into on-demand skills while preserving prompt stubs with hard safety constraints.

Details:
- Added mirrored `.opencode` and `.claude` skill files for `plan` and `execute`.
- Kept architect trigger/action stubs plus critical gate-selection, scope, retry, and completion constraints inline.
- Added focused skill protocol tests for the extracted mode bodies.
- Ships the extraction as a patch release because the refactor changes the architect's runtime prompt-loading path and should be available in the published npm package for validation.
