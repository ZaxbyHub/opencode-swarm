# External Skill Curation Pipeline

## What changed

Implements an opt-in, quarantine-first external skill curation pipeline (Closes #1179). External skill content is never executed during discovery or validation — all candidates are quarantined until a human explicitly promotes them.

## New tools

Seven new tools are available when `external_skills.curation_enabled: true`:

| Tool | Description |
|------|-------------|
| `external_skill_discover` | Fetch skill candidates from configured sources, validate through 3 security gates, store in quarantine |
| `external_skill_list` | List candidates in quarantine store with filtering by status, source, date range |
| `external_skill_inspect` | Inspect a specific candidate by ID, returning full metadata and validation results |
| `external_skill_promote` | Promote validated candidate to active generated skill with TOCTOU re-validation |
| `external_skill_reject` | Mark candidate as rejected with audit trail |
| `external_skill_delete` | Delete candidate from quarantine store |
| `external_skill_revoke` | Revoke a previously promoted skill, preserving audit trail |

## Security gates

All candidates pass through 3 validation gates:

1. **Prompt injection scan** — 12 regex patterns detect prompt injection attempts
2. **Unsafe instruction scan** — 25 patterns detect dangerous shell/system instructions
3. **Provenance integrity check** — SHA-256 hash verification, timestamp, URL, publisher, and hash cross-check

## Promotion flow

- TOCTOU re-validation re-runs all 3 gates before promotion
- Requires explicit `approver` parameter (human-only)
- Uses exclusive file open (`O_CREAT | O_EXCL`) to prevent race conditions
- Writes SKILL.md to `.opencode/skills/generated/<slug>/` with provenance frontmatter

## Configuration

Disabled by default. Enable in `.opencode/opencode-swarm.json`:

```json
{
  "external_skills": {
    "curation_enabled": true,
    "sources": [
      { "type": "github", "location": "https://github.com/org/skills", "trust_level": "medium" }
    ]
  }
}
```

See `docs/configuration.md` for full config options including sources, TTL, and trust levels.

## Testing

434 tests across 17 test files covering tools, services, config, hooks, adversarial attacks, and lifecycle integration.

## Files changed

- `src/services/external-skill-store.ts` — Candidate store (JSONL-based quarantine)
- `src/services/external-skill-validator.ts` — 3-gate validation pipeline
- `src/tools/external-skill-*.ts` — 7 curation tools
- `src/config/schema.ts` — Config schema with DiscoverySourceSchema
- `src/config/loader.ts` — Config resolver for external skills
- `src/agents/architect.ts` — Architect prompt additions
- `src/agents/index.ts` — Agent tool map updates
- `src/hooks/knowledge-validator.ts` — Path validation hook for skill candidates
- `src/tools/index.ts`, `manifest.ts`, `tool-metadata.ts` — Tool registration
- `src/config/constants.ts` — Tool names and agent maps
- `README.md` — External Skill Curation section
- `docs/configuration.md` — Schema table, examples, troubleshooting

## Known gaps (deferred)

- No secondary SSRF URL filter in `fetchContent` (defense is caller-side `isSubpathUrl`)
- No URL/HTML decoding before regex scan
- No LLM-based semantic analysis ("slow gate")

## Migration

No migration required. Feature is disabled by default and does not affect existing behavior.
