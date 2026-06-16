# Security: Apply external content scanning to gitingest and web_search

## Summary

Fixed [#1278](https://github.com/zaxbysauce/opencode-swarm/issues/1278): inconsistent prompt-injection treatment across external content sources.

Previously, `gitingest` and `web_search` returned external content directly to the LLM without scanning, while the external-skill curation pipeline applied comprehensive threat detection. This asymmetry created a security gap where attacker-controlled repository content or malicious web snippets could inject prompts directly into model context.

## Changes

1. **Created `external-content-scanner.ts`**: Shared ingress point for arbitrary external text that applies prompt-injection and unsafe-instruction scanning before content enters the LLM context.
   - Reuses existing 12-pattern prompt-injection and 25-pattern unsafe-instruction detection from `external-skill-validator.ts`
   - Returns threat level, findings, and neutralized content with threat markers wrapped
   - Trust-level modulation (default: `low` treats warnings as errors)

 2. **Integrated scanner into `gitingest.ts`**:
    - All fetched repository content (summary, tree, file content) scanned for threats
    - Added streaming byte cap to prevent unbounded buffering (early-abort on size limit)
    - **Behavioral change**: When threats are detected, the response is prepended with a `[GITINGEST SECURITY NOTE: ...]` header followed by the threat summary and neutralized content. Clean content is returned as-is with no modification.
    - Streaming reader now uses `try/finally` to ensure `reader.cancel()` is called on error, preventing resource leaks.

3. **Integrated scanner into `web_search.ts`**:
   - Result titles and snippets scanned for threats before returning
   - Added `threatLevel` field to each result (`'error' | 'warning' | 'none'`)
   - Threat patterns wrapped with markers for LLM awareness

4. **Comprehensive test coverage**:
   - 32 tests for `external-content-scanner` (pattern detection, neutralization, trust levels, edge cases)
   - 13 integration tests verifying malicious payloads are detected/neutralized in both tools
   - All existing tool tests pass (166 total)

## Security Impact

- **Closes asymmetry**: gitingest and web_search now apply the same threat detection as external-skill curation
- **Defense in depth**: Threat patterns wrapped and marked for LLM awareness
- **Future-proof**: Shared scanner ensures all future network-content tools inherit treatment by default
- **No breaking changes**: Clean content returned unchanged; only malicious payloads marked

## Known limitations

- Streaming implementation has fallback to `response.text()` for compatibility
- Content marked with threat patterns rather than blocking (allows agents to assess and document threats)
- 50KB default size limit for scanned content (configurable)

## Migration

No migration required. The changes are transparent to existing code paths.

## Testing

Run the focused security test suite:
```bash
bun test tests/unit/services/external-content-scanner.test.ts
bun test tests/unit/tools/gitingest.test.ts tests/unit/tools/web-search.*.test.ts
bun test tests/integration/security-scanning.test.ts
```

All 166 tests pass ✓
