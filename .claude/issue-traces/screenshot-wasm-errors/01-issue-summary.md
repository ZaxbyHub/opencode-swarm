# Issue Summary

## Source
- Issue: User-provided screenshot (no GitHub issue number)
- Repo: zaxbysauce/opencode-swarm
- Branch: claude/trace-screenshot-errors-dYbnw
- State: open / in-triage

## Observed Behavior
Multiple terminal errors on a Windows machine when running opencode-swarm via the opencode application:

```
failed to asynchronously prepare wasm: Error: ENOENT: no such file or directory,
  open 'C:\Users\zaxby\.cache\opencode\packages\opencode-swarm@latest\
  node_modules\opencode-swarm\dist\lang\grammars\tree-sitter.wasm'

Aborted(Error: ENOENT: no such file or directory,
  open '...dist\lang\grammars\tree-sitter.wasm')
```

The error repeats 3+ times simultaneously (same path, different concurrent callers).

The screenshot also showed what appeared to be corrupted paths like
`dist\commands\registry.d.ts\lang\grammars\tree-sitter.wasm`. Investigation
confirmed these are a UI rendering artifact: OpenCode's left panel shows file
diffs (.d.ts files with `+16`, `+13` line delta badges) at the same y-coordinate
as the terminal errors in the right panel. The actual path in every error is the
same: `dist\lang\grammars\tree-sitter.wasm`.

## Expected Behavior
opencode-swarm should load successfully with tree-sitter grammar support working
on Windows, without any ENOENT errors.

## Reproduction Steps
1. Install `opencode-swarm@latest` globally via npm on Windows
2. Run opencode with the opencode-swarm plugin active
3. Trigger any feature that loads a tree-sitter grammar (syntax check, AST diff,
   language detection)
4. Observe ENOENT errors for `dist\lang\grammars\tree-sitter.wasm`

## Environment
- Runtime: Node.js (opencode application host)
- OS/platform: Windows (C:\Users\zaxby paths confirmed)
- Package location: `C:\Users\zaxby\.cache\opencode\packages\opencode-swarm@latest\node_modules\opencode-swarm\`
- Feature flags/config: n/a

## Acceptance Criteria
- [ ] opencode-swarm loads without ENOENT for tree-sitter.wasm on Windows
- [ ] Multiple concurrent grammar loads do not produce multiple wasm init failures
- [ ] `dist/lang/grammars/tree-sitter.wasm` is present in the published package

## Ambiguities
- Whether the wasm files are missing from the published package OR whether the
  concurrent-init race condition alone causes the failures even when the file exists.
- Whether opencode loads `dist/index.js` or `dist/cli/index.js` for the plugin entry.
