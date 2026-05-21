# Common CI Failure Patterns & Solutions

## Quick Reference: Error → Likely Cause → Fix

### Node.js / JavaScript / TypeScript

| Error Pattern | Likely Cause | Fix |
|---|---|---|
| `Cannot find module 'X'` | Missing dependency or wrong import path | `npm install X` or fix import |
| `ERR_MODULE_NOT_FOUND` | ESM/CJS mismatch | Check `type: "module"` in package.json, file extensions |
| `ENOMEM` / `JavaScript heap out of memory` | Build exceeds memory | Add `--max-old-space-size=4096` to Node options |
| `npm ERR! ERESOLVE` | Dependency version conflict | `npm install --legacy-peer-deps` or resolve conflict |
| `npm ERR! code EINTEGRITY` | Corrupted cache or lock file | Delete `node_modules` and `package-lock.json`, reinstall |
| `SyntaxError: Unexpected token` | Wrong Node version or TypeScript config | Check CI Node version matches local |
| `Type error: X is not assignable to Y` | TypeScript strict mode catching new issue | Fix the type or update the interface |
| Snapshot test failure (`- Snapshot / + Received`) | UI changed, snapshot stale | Update snapshots: `npm test -- -u` (verify changes first!) |

### Python

| Error Pattern | Likely Cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | Missing dependency | Add to requirements.txt/pyproject.toml |
| `ImportError: cannot import name` | Circular import or renamed export | Check import chain |
| `SyntaxError` | Wrong Python version | Check CI Python version |
| `pip: ResolutionImpossible` | Conflicting version constraints | Loosen constraints or pin specific versions |

### Rust

| Error Pattern | Likely Cause | Fix |
|---|---|---|
| `error[E0433]: failed to resolve` | Missing use statement or dependency | Add `use` or dependency to Cargo.toml |
| `error[E0308]: mismatched types` | Type error | Fix type annotations |
| Clippy warnings as errors | Lint violations | Fix the Clippy warnings |

### Docker / Container

| Error Pattern | Likely Cause | Fix |
|---|---|---|
| `COPY failed: file not found` | .dockerignore excluding needed file, or wrong path | Check .dockerignore, fix COPY path |
| `no space left on device` | Runner disk full, large layers | Multi-stage build, clean layers, prune cache |
| `apt-get: package not found` | Stale package index | Add `apt-get update` before install |

### GitHub Actions Specific

| Error Pattern | Likely Cause | Fix |
|---|---|---|
| `Resource not accessible by integration` | Insufficient permissions | Add `permissions:` block to workflow |
| `Error: Process completed with exit code 128` | Git auth failure | Check `GITHUB_TOKEN` permissions, `actions/checkout` depth |
| `No space left on device` | Runner disk full | Add cleanup step or reduce artifact size |
| `The job was cancelled` | Timeout or concurrency cancellation | Increase `timeout-minutes` or check concurrency settings |
| Cache miss every run | Cache key too specific | Use broader restore-keys pattern |
| `annotations` limit exceeded | Too many warnings | Fix warnings or filter annotation output |

### Bun / Test Isolation

| Error Pattern | Likely Cause | Fix |
|---|---|---|
| Test passes alone, fails in suite | Mock leakage between test files | Add `vi.clearAllMocks()` / `mock.restore()` in afterEach |
| `Expected X, Received undefined` when running full suite | Module mock from another file overrides current mock | Use `mock.module()` with `restore` or isolate tests |
| Knowledge/store entries from wrong test | Shared filesystem state between parallel test files | Use `mkdtempSync` per test, never share dirs |
| `execFile` mock not called | Another test file mocked `child_process` differently | Ensure mock.module calls are file-scoped |
