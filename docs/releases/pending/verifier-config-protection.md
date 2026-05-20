# Verifier Config Protection

## What changed

- **Architect config zone protection**: Added `config` zone to the architect agent's `blockedZones` and added `blockedGlobs` for 8 known verifier config file patterns (oxlintrc, eslintrc, eslint.config, prettierrc, prettier.config, biome.jsonc, secretscanignore, golangci). The architect can no longer directly edit config files to bypass lint/test gates.

- **Shell audit hardening**: Added DENY patterns for `sed -i` targeting config files with severity keywords, plus ESCALATE patterns for `echo`/`printf`/`cat`/`tee`/sed writes to known config files (including `tsconfig.build.json`-style variants). Prevents shell-based config sabotage.

- **Config-file write logging**: Added detection and logging in the `toolBefore` hook that records agent name, file path, and verdict for every config-file write attempt.

- **User-extensible verifier configs**: Added `verifier_config_paths` field to `AuthorityConfig` schema. User-supplied glob patterns are merged into the architect's `blockedGlobs` at plugin init — writes to matching files are actually blocked, not just logged.

- **Reviewer config-strictness gate**: Added CONFIG STRICTNESS VERIFICATION section to the reviewer agent prompt, instructing reviewers to reject config changes that reduce strictness.

## Why

Issue #894: Swarm agents were bypassing lint/test gates by editing config files from `"error"` to `"warn"` instead of fixing the underlying source code. This closes three bypass vectors: direct architect edits (missing `config` zone), shell command bypass (missing DENY/ESCALATE patterns), and reviewer gap (no explicit strictness instruction).

## Migration steps

None required. All changes are additive. Users who want to extend the built-in verifier config protection can add `authorityConfig.verifier_config_paths` to their `opencode-swarm.json`.

## Known caveats

- Config files nested under `.github/` are excluded from `config` zone classification (design constraint in the zone classifier)
- Non-standard file extensions (e.g., `.JSYC`) bypass `config` zone detection
