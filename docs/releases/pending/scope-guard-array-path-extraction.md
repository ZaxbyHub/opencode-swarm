## scope-guard: array-path extraction and security hardening

Scope guard now extracts paths from both single-string and array-based tool arguments, closing a scope bypass vulnerability where tools passing `files[]`, `paths[]`, or `targetFiles[]` could write outside declared scope.

### Changed

- **`sanitizePath`** — now replaces the full C0 control-character range (`0x00–0x1F`), DEL (`0x7F`), ESC (`0x1B`), C1 controls (`0x80–0x9F`), and ANSI CSI sequences with underscores. This sanitization prevents `path.resolve()` from throwing `ERR_INVALID_ARG_VALUE` on embedded null bytes and bypassing the SCOPE VIOLATION error path.
- **`isFileInScope`** — filters empty-string scope entries before checking, preventing `path.resolve(dir, '')` from resolving to the project root and silently allowing all files.
- **Path extraction** — collects from single-string keys (`path`, `filePath`, `file`) AND array keys (`files`, `paths`, `targetFiles`). Validates every collected path rather than stopping at the first match.

### Why

A tool call that passes multiple target paths via an array argument could write to files outside the declared scope if only the first path was checked. The collect-all-then-validate pattern ensures every path in the array is validated against the declared scope.

### Testing

78 tests across 6 test files pass, covering single-string paths, array paths, empty-string filtering, and control-character stripping.
