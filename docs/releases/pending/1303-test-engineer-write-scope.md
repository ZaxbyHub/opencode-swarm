# fix: test_engineer can now write test files (issue #1303, PR #1305)

The `test_engineer` agent was unable to write test files and would fall into
retry loops. Three root causes were fixed:

1. **`apply_patch` added to test_engineer's tool map** — `apply_patch` (the
   plugin's unified-diff write tool) was only registered for `coder`. Adding it
   to `test_engineer` allows the agent to create and modify test files using the
   same write mechanism that `coder` uses.

2. **Architect prompt updated with `declare_scope` guidance for test_engineer** —
   Rule 1a and new Rule 3b now instruct the architect to call `declare_scope`
   with the target test file paths before any `test_engineer` delegation that
   will write new test files. This mirrors the existing coder scope discipline
   and prevents scope-guard blocks in sessions where a task ID is active.

3. **Cross-language test file patterns added to write authority** - the
   `test_engineer` authority rules now recognize the test-file conventions
   advertised in the agent prompt, including Python `test_*.py` / `*_test.py`,
   Go `*_test.go`, Ruby `*_spec.rb`, JUnit `*Test.java`, C# `*Tests.cs`, and
   PowerShell `*.Tests.ps1`. These paths remain blocked in generated output
   directories such as `dist/` and `build/`.
