# Search ripgrep runner hardening

Hardened the `search` tool's ripgrep execution path so it uses an explicit working directory, ignored stdin, bounded stdout/stderr, a concrete timeout, and best-effort cleanup through a shared external-tool runner.

The Node fallback search now uses bounded traversal, default skips for heavy runtime directories, realpath-based containment checks, and a warning that fallback behavior does not fully emulate ripgrep gitignore semantics.

Added read-only `ast_grep`, `actionlint_scan`, `osv_scan`, and `gh_evidence` tools that run structural search, GitHub Actions linting, OSV dependency scanning, and bounded GitHub evidence collection through the same bounded external-tool runner, with lazy binary resolution, workspace-relative output normalization where applicable, and structured missing-binary guidance.
