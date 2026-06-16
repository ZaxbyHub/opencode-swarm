# Config Doctor coverage closure

## What

Extended config-doctor validation from 9 to 62+ top-level schema keys with full type coverage and new security hardening.

**Validation coverage expansion:**
- Extended `validateConfigKey` to cover all 62+ top-level schema keys with type checks (string, boolean, number, object)
- Added 818 unit tests and 29 adversarial tests covering the new validation paths
- Auto-generated test inventory covers 156 range-bounded numeric keys (e.g. `max_iterations`, `qa_retry_limit`) with auto-clamp support

**Unknown key detection:**
- Unknown top-level config keys now produce `warn` severity findings
- Levenshtein distance (≤ 2) used to suggest corrections for typos (case-insensitive)
- Single-match suggestions shown in the finding description

**Path-traversal protection:**
- `isValidConfigPath` uses exact resolved-path matching with symlink rejection (removed permissive regex patterns that allowed crafted paths to bypass validation)
- `restoreFromBackup` validates that the backup path is within the project's `.swarm/` directory

**Swarms hardening:**
- Empty `swarms: {}` now emits an INFO finding ("No swarm configurations are defined")
- Path-traversal characters in swarm IDs (`..`, `/`, `\`, `\0`) produce HIGH/ERROR findings
- This prevents malicious or accidental swarm IDs that could escape containment

**Deprecated field flagging:**
- `skill_improver.model` → `agents.skill_improver.model` (INFO)
- `skill_improver.fallback_models` → `agents.skill_improver.fallback_models` (INFO)
- `spec_writer.model` → `agents.spec_writer.model` (INFO)
- `spec_writer.fallback_models` → `agents.spec_writer.fallback_models` (INFO)

## Why

The config-doctor had limited validation coverage (9 keys). Users with typos in config keys or deprecated field usage received no feedback. The extended coverage provides proactive discovery of configuration issues before they cause runtime failures.

## Migration

No migration required. Existing configs continue to work. Deprecated field findings are advisory INFO-level — they do not block startup or operation.

## Breaking changes

None.
